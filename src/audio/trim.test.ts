import { describe, expect, it } from 'vitest'
import { analyzeSamples } from './analyze'
import { renderTestRhythm } from './synth'
import { analyzeTrimSuggestions, applyTrimSuggestion, autoTrimWindow, normalizeTrimWindow } from './trim'
import { toPeakBytes } from '../core/math'
import type { AnalysisResult, OnsetEvent, Section } from '../core/types'

/** Hand-built analysis: only the fields the trim logic reads matter, but the type stays complete. */
function fakeAnalysis(input: {
  duration: number
  envelope: (t: number) => number
  rate?: number
  sections?: Section[]
  silentRegions?: { start: number; end: number }[]
  onsets?: OnsetEvent[]
}): AnalysisResult {
  const rate = input.rate ?? 10
  const frames = Math.max(1, Math.round(input.duration * rate))
  const envelope = new Float32Array(frames)
  for (let i = 0; i < frames; i++) envelope[i] = input.envelope(i / rate)
  return {
    version: 'test',
    bpm: 120,
    bpmConfidence: 0.8,
    offset: 0,
    phaseConfidence: 0.8,
    gridResidualMs: 10,
    candidates: [],
    beats: Math.round(input.duration / 0.5),
    beatsPerBar: 4,
    sections: input.sections ?? [],
    silentRegions: input.silentRegions ?? [],
    limitations: [],
    envelope,
    envelopeRate: rate,
    bandEnvelopes: [],
    onsets: input.onsets ?? [],
    beatTimes: [],
  }
}

const section = (start: number, end: number, kind: Section['kind'] = 'groove', energy = 0.8): Section => ({
  start,
  end,
  energy,
  kind,
})

describe('trim suggestions with real analysis', () => {
  it('finds a synthetic lead-in and trims the silent tail', () => {
    const truth = renderTestRhythm({ bpm: 120, bars: 16, leadInSeconds: 3, seed: 11 })
    const analysis = analyzeSamples(truth.samples, truth.sampleRate)
    const suggestions = analyzeTrimSuggestions(analysis, truth.duration)

    const intro = suggestions.find((s) => s.action === 'trim-start')
    expect(intro, JSON.stringify(suggestions.map((s) => s.kind))).toBeDefined()
    // The synth lead-in is exactly 3 s; allow the envelope/onset refinement to be a little off.
    expect(intro!.end).toBeGreaterThan(2.4)
    expect(intro!.end).toBeLessThan(3.6)

    const auto = autoTrimWindow(analysis, truth.duration, toPeakBytes(truth.samples, 1400))
    expect(auto.applied.length).toBeGreaterThan(0)
    expect(auto.window.start).toBeGreaterThan(2.4)
    expect(auto.window.start).toBeLessThan(3.9)
    // The synth ends with 2 s of digital silence. Auto-trim keeps a two-second musical tail
    // instead of snapping to the last onset, so the results screen does not arrive on a hard cut;
    // with only 2 s of silence that means playing to the end of the file.
    expect(auto.window.end).toBeGreaterThan(35)
    expect(auto.window.end).toBeLessThanOrEqual(truth.duration + 1e-6)
  })

  it('offers nothing for a flat, constantly-loud envelope', () => {
    const analysis = fakeAnalysis({ duration: 30, envelope: () => 0.5 })
    expect(analyzeTrimSuggestions(analysis, 30)).toEqual([])
  })
})

describe('edge suggestions', () => {
  it('detects a silent intro and applies it with a small run-up', () => {
    const analysis = fakeAnalysis({
      duration: 40,
      envelope: (t) => (t < 5 ? 0.02 : 0.9),
      silentRegions: [{ start: 0, end: 5 }],
    })
    const suggestions = analyzeTrimSuggestions(analysis, 40)
    const intro = suggestions.find((s) => s.kind === 'silence-intro')
    expect(intro).toBeDefined()
    expect(intro!.start).toBe(0)
    expect(intro!.end).toBeCloseTo(5, 1)

    const applied = applyTrimSuggestion({ start: 0, end: 40 }, intro!, 40)
    expect(applied.start).toBeCloseTo(5.25, 1)
    expect(applied.end).toBe(40)
  })

  it('detects a long quiet outro even without silent regions', () => {
    const analysis = fakeAnalysis({
      duration: 48,
      envelope: (t) => (t < 40 ? 0.9 : 0.08),
    })
    const suggestions = analyzeTrimSuggestions(analysis, 48)
    const outro = suggestions.find((s) => s.action === 'trim-end')
    expect(outro).toBeDefined()
    expect(outro!.start).toBeGreaterThan(39)
    expect(outro!.start).toBeLessThan(41)
    expect(outro!.detail).toMatch(/fade|outro|talking|noise/i)

    const applied = applyTrimSuggestion({ start: 0, end: 48 }, outro!, 48)
    expect(applied.end).toBeLessThan(40.5)
    expect(applied.start).toBe(0)
  })

  it('keeps a quiet outro that is shorter than the minimum', () => {
    const analysis = fakeAnalysis({
      duration: 48,
      envelope: (t) => (t < 45 ? 0.9 : 0.08), // only 3 s of quiet, below the 4 s floor
    })
    expect(analyzeTrimSuggestions(analysis, 48).filter((s) => s.action === 'trim-end')).toEqual([])
  })

  it('describes a sparse non-percussive intro as possibly spoken', () => {
    const analysis = fakeAnalysis({
      duration: 60,
      envelope: (t) => (t < 8 ? 0.1 + 0.05 * Math.sin(t * 2) : 0.9),
      onsets: [{ time: 2, strength: 0.4, band: 2, brightness: 0.2 }], // one weak blip in 8 s
    })
    const intro = analyzeTrimSuggestions(analysis, 60).find((s) => s.action === 'trim-start')
    expect(intro).toBeDefined()
    expect(intro!.label).toMatch(/spoken/i)
    expect(intro!.detail).toMatch(/speech|count-in|free-time/i)
  })
})

describe('repeated sections', () => {
  const pattern = (t: number): number => 0.5 + 0.4 * Math.sin((2 * Math.PI * t) / 4)

  it('offers to remove the second pass of a repeated section, snapped to whole bars', () => {
    const analysis = fakeAnalysis({
      duration: 70,
      envelope: (t) => {
        if (t >= 10 && t < 30) return pattern(t)
        if (t >= 38 && t < 58) return pattern(t) // 28 s later = 7 whole 4 s periods → same phase
        return 0.3
      },
      sections: [section(10, 30), section(38, 58)],
    })
    const repeats = analyzeTrimSuggestions(analysis, 70).filter((s) => s.kind === 'repeat-section')
    expect(repeats).toHaveLength(1)
    expect(repeats[0].action).toBe('remove-section')
    // The removed region is the second pass; 120 BPM 4/4 → 2 s bars, and 38/58 are both bar lines.
    expect(repeats[0].start).toBeCloseTo(38, 6)
    expect(repeats[0].end).toBeCloseTo(58, 6)
    expect(repeats[0].detail).toMatch(/similarity/i)
    expect(repeats[0].detail).toMatch(/bar/i)

    // A remove-section suggestion never rewrites the window; the UI turns it into a cut instead.
    expect(applyTrimSuggestion({ start: 0, end: 70 }, repeats[0], 70)).toEqual({ start: 0, end: 70 })
  })

  it('does not pair sections whose patterns differ', () => {
    const analysis = fakeAnalysis({
      duration: 70,
      envelope: (t) => {
        if (t >= 10 && t < 30) return pattern(t)
        if (t >= 40 && t < 60) return 0.5 + 0.4 * Math.sin((2 * Math.PI * t) / 1.3 + 1.7)
        return 0.3
      },
      sections: [section(10, 30), section(40, 60)],
    })
    expect(analyzeTrimSuggestions(analysis, 70).filter((s) => s.kind === 'repeat-section')).toEqual([])
  })

  it('mentions the total length when the song is long', () => {
    const analysis = fakeAnalysis({
      duration: 340,
      envelope: (t) => {
        if (t >= 100 && t < 130) return pattern(t)
        if (t >= 200 && t < 230) return pattern(t)
        return 0.3
      },
      sections: [section(100, 130), section(200, 230)],
    })
    const repeats = analyzeTrimSuggestions(analysis, 340).filter((s) => s.kind === 'repeat-section')
    expect(repeats).toHaveLength(1)
    expect(repeats[0].detail).toMatch(/long/i)
  })
})

describe('normalizeTrimWindow', () => {
  it('falls back to the full song for missing or absurd windows', () => {
    expect(normalizeTrimWindow(null, 100)).toEqual({ start: 0, end: 100 })
    expect(normalizeTrimWindow({ start: Number.NaN, end: 50 }, 100)).toEqual({ start: 0, end: 100 })
    expect(normalizeTrimWindow({ start: 60, end: 60 }, 100)).toEqual({ start: 0, end: 100 })
    expect(normalizeTrimWindow({ start: -5, end: 120 }, 100)).toEqual({ start: 0, end: 100 })
    expect(normalizeTrimWindow({ start: 10, end: 90 }, 100)).toEqual({ start: 10, end: 90 })
  })
})
