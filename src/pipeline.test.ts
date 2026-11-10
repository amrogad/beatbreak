import { describe, expect, it } from 'vitest'
import { renderTestRhythm } from './audio/synth'
import { analyzeSamples } from './audio/analyze'
import { TimingMap } from './chart/timing'
import { BAR_BEATS, groupBars, tempoFromRepeats } from './chart/structure'
import { settleBeatLine } from './audio/tempo'
import {
  DIFFICULTY_PROFILES,
  applyHolds,
  clipNotesToEdit,
  generateChart,
  generateAllDifficulties,
  rateSong,
  resolveSettings,
  selectCandidates,
  validatePlayability,
} from './chart/generate'
import { buildEditPlan, isCut } from './core/edit'
import type { AnalysisResult, ChartNote, SongTexture } from './core/types'

/**
 * End-to-end pipeline tests: synthetic drum pattern → analysis → timing → charts.
 * The synthetic song's true BPM, beat phase and section structure are known by construction, so
 * these assertions are real checks on the algorithms rather than golden-file snapshots.
 */

let cached: { analysis: AnalysisResult; duration: number; truth: ReturnType<typeof renderTestRhythm> } | null = null

function analyseDemo(bpm = 128) {
  if (cached && cached.truth.bpm === bpm) return cached
  const truth = renderTestRhythm({ bpm, bars: 20, leadInSeconds: 0.35, seed: 1234 })
  const analysis = analyzeSamples(truth.samples, truth.sampleRate)
  cached = { analysis, duration: truth.duration, truth }
  return cached
}

describe('tempo estimation', () => {
  it('finds the true BPM of a synthetic drum pattern', () => {
    for (const bpm of [100, 128, 150]) {
      const truth = renderTestRhythm({ bpm, bars: 16, seed: 7 })
      const analysis = analyzeSamples(truth.samples, truth.sampleRate)
      const error = Math.abs(analysis.bpm - bpm) / bpm
      expect(error, `estimated ${analysis.bpm} for ${bpm}`).toBeLessThan(0.03)
    }
  })

  it('aligns the beat grid with the true beat positions', () => {
    const { analysis, truth } = analyseDemo(128)
    const period = 60 / truth.bpm
    // Every detected beat should sit on the true beat grid, allowing for the grid being able to
    // start at any beat of the song.
    let worst = 0
    for (const beat of analysis.beatTimes.slice(0, 40)) {
      const relative = (((beat - truth.offset) % period) + period) % period
      worst = Math.max(worst, Math.min(relative, period - relative))
    }
    expect(worst, `worst grid error ${(worst * 1000).toFixed(1)} ms`).toBeLessThan(0.045)
  })

  it('reports honest confidence numbers', () => {
    const { analysis } = analyseDemo()
    expect(analysis.bpmConfidence).toBeGreaterThan(0.3)
    expect(analysis.bpmConfidence).toBeLessThanOrEqual(1)
    expect(analysis.phaseConfidence).toBeGreaterThanOrEqual(0)
  })

  it('flags a noisy, rhythmless signal instead of inventing a strong tempo', () => {
    // Speech-like noise: filtered noise with slow amplitude modulation and no periodic onsets.
    const sampleRate = 22050
    const length = sampleRate * 20
    const samples = new Float32Array(length)
    let state = 12345
    let lowpass = 0
    for (let i = 0; i < length; i++) {
      state = (state * 1103515245 + 12345) & 0x7fffffff
      const white = (state / 0x7fffffff) * 2 - 1
      lowpass += (white - lowpass) * 0.05
      const modulation = 0.5 + 0.5 * Math.sin((2 * Math.PI * i) / (sampleRate * 3.7))
      samples[i] = lowpass * modulation * 0.5
    }
    const noise = analyzeSamples(samples, sampleRate, { bands: 4 })
    const music = analyseDemo().analysis

    // The honest requirement is not "find nothing" — it is "do not claim the same confidence as
    // real rhythmic material, and say something about it".
    expect(noise.bpmConfidence).toBeLessThan(music.bpmConfidence - 0.15)
    expect(noise.gridResidualMs).toBeGreaterThan(music.gridResidualMs)
    expect(noise.limitations.length).toBeGreaterThan(0)
    expect(noise.limitations.join(' ')).toMatch(/line up|scatter|ambiguous|rubato|bar length/i)
  })
})

describe('analysis output', () => {
  it('produces display data and onsets in range', () => {
    const { analysis, duration } = analyseDemo()
    expect(analysis.envelope.length).toBe(900)
    expect(analysis.envelopeRate).toBeCloseTo(900 / duration, 1)
    expect(analysis.onsets.length).toBeGreaterThan(80)
    for (const onset of analysis.onsets) {
      expect(onset.strength).toBeGreaterThan(0)
      expect(onset.strength).toBeLessThanOrEqual(1)
      expect(onset.time).toBeGreaterThanOrEqual(0)
      expect(onset.band).toBeGreaterThanOrEqual(0)
      expect(onset.band).toBeLessThan(4)
    }
  })

  it('detects silent regions', () => {
    const truth = renderTestRhythm({ bpm: 120, bars: 8, leadInSeconds: 3, seed: 3 })
    const analysis = analyzeSamples(truth.samples, truth.sampleRate)
    expect(analysis.silentRegions.length).toBeGreaterThan(0)
    expect(analysis.silentRegions[0].start).toBeLessThan(0.5)
    expect(analysis.silentRegions[0].end).toBeGreaterThan(1.5)
  })
})

describe('chart generation', () => {
  it('generates all four difficulties with increasing density', () => {
    const { analysis, duration } = analyseDemo()
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    const charts = generateAllDifficulties({
      analysis,
      timing,
      duration,
      songId: 'demo',
      title: 'Test Rhythm',
    })
    expect(charts).toHaveLength(4)
    const counts = charts.map((c) => c.stats.noteCount)
    expect(counts[0]).toBeGreaterThan(20)
    expect(counts[1]).toBeGreaterThan(counts[0])
    expect(counts[2]).toBeGreaterThan(counts[1])
    expect(counts[3]).toBeGreaterThan(counts[2])

    for (const chart of charts) {
      expect(chart.notes.length).toBe(chart.stats.noteCount)
      expect(chart.timing.bpms[0].bpm).toBeCloseTo(analysis.bpm, 6)
      expect(chart.timing.offset).toBeCloseTo(analysis.offset, 6)
      expect(chart.stepsPerBeat).toBe(DIFFICULTY_PROFILES[chart.difficulty].stepsPerBeat)
    }
  })

  it('snaps hard note heads to the grid near a detected onset, ordered and inside the song', () => {
    const { analysis, duration } = analyseDemo()
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    const chart = generateChart({ analysis, timing, duration, songId: 'demo', difficulty: 'hard' })

    let previous = -Infinity
    for (const note of chart.notes) {
      expect(note.time).toBeGreaterThanOrEqual(previous)
      previous = note.time
      expect(note.time).toBeGreaterThanOrEqual(0)
      expect(note.time).toBeLessThanOrEqual(duration)
      const nearestOnset = Math.min(...analysis.onsets.map((onset) => Math.abs(onset.time - note.time)))
      expect(nearestOnset).toBeLessThan(0.056)
      const beat = timing.timeToBeat(note.time)
      const onGrid = Math.abs(beat * 4 - Math.round(beat * 4)) < 1e-6 || Math.abs(beat * 6 - Math.round(beat * 6)) < 1e-6
      expect(onGrid).toBe(true)
      expect(note.lane).toBeGreaterThanOrEqual(0)
      expect(note.lane).toBeLessThanOrEqual(3)
    }
  })

  it('uses a finer grid on Hard/Expert when the detected tempo is slow', () => {
    const truth = renderTestRhythm({ bpm: 96, bars: 12, seed: 3 })
    const analysis = analyzeSamples(truth.samples, truth.sampleRate)
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    const charts = generateAllDifficulties({ analysis, timing, duration: truth.duration, songId: 'slow' })
    expect(charts.map((chart) => chart.stepsPerBeat)).toEqual([1, 2, 8, 8])
  })

  it('flags an arrow inside a same-lane long arrow and a long arrow with no length', () => {
    const { analysis, duration } = analyseDemo()
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    const chart = generateAllDifficulties({ analysis, timing, duration, songId: 'demo' })[0]
    const base = { strength: 0.5, beat: 0, step: 0 }
    const notes = [
      { ...base, id: 'h', lane: 0 as const, time: 1, kind: 'hold' as const, duration: 1 },
      { ...base, id: 'in', lane: 0 as const, time: 1.5, kind: 'tap' as const },
      { ...base, id: 'z', lane: 1 as const, time: 3, kind: 'hold' as const, duration: 0 },
    ]
    const codes = validatePlayability({ ...chart, notes }, duration).issues.map((issue) => issue.code)
    expect(codes).toContain('inside-hold')
    expect(codes).toContain('bad-hold')
  })

  it('produces physically playable charts at every difficulty', () => {
    const { analysis, duration } = analyseDemo()
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    for (const chart of generateAllDifficulties({ analysis, timing, duration, songId: 'demo' })) {
      const report = validatePlayability(chart, duration)
      const badIssues = report.issues.filter((i) => i.severity === 'error')
      expect(badIssues.map((i) => `${i.code}: ${i.message}`)).toEqual([])
      expect(report.ok).toBe(true)
    }
  })

  it('never exceeds the difficulty chord limit and never stacks a lane twice', () => {
    const { analysis, duration } = analyseDemo()
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    for (const chart of generateAllDifficulties({ analysis, timing, duration, songId: 'demo' })) {
      const byTime = new Map<number, number[]>()
      for (const note of chart.notes) {
        const key = Math.round(note.time * 1000)
        byTime.set(key, [...(byTime.get(key) ?? []), note.lane])
      }
      for (const lanes of byTime.values()) {
        expect(new Set(lanes).size).toBe(lanes.length)
        expect(lanes.length).toBeLessThanOrEqual(Math.max(2, chart.generator.maxChord))
      }
      if (chart.difficulty === 'easy') {
        expect([...byTime.values()].every((lanes) => lanes.length === 1)).toBe(true)
      }
    }
  })

  it('is deterministic for a given seed and reacts to a different seed', () => {
    const { analysis, duration } = analyseDemo()
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    const a = generateChart({ analysis, timing, duration, songId: 'demo', difficulty: 'expert', options: { seed: 42 } })
    const b = generateChart({ analysis, timing, duration, songId: 'demo', difficulty: 'expert', options: { seed: 42 } })
    const c = generateChart({ analysis, timing, duration, songId: 'demo', difficulty: 'expert', options: { seed: 43 } })
    expect(a.notes.map((n) => `${n.time}:${n.lane}`)).toEqual(b.notes.map((n) => `${n.time}:${n.lane}`))
    expect(c.notes.map((n) => `${n.time}:${n.lane}`)).not.toEqual(a.notes.map((n) => `${n.time}:${n.lane}`))
  })

  it('stays on the music when the phase estimate shifts', () => {
    const { analysis, duration } = analyseDemo()
    const base = TimingMap.single(analysis.bpm, analysis.offset)
    const shifted = base.withOffset(analysis.offset + 0.05)
    const a = generateChart({ analysis, timing: base, duration, songId: 'demo', difficulty: 'normal' })
    const b = generateChart({ analysis, timing: shifted, duration, songId: 'demo', difficulty: 'normal' })
    // Easy/Normal snap to the grid, but the selected grid step must still be close to a real
    // onset. A phase correction may change which onsets fit, never invent a note in silence.
    for (const chart of [a, b]) {
      for (const note of chart.notes) {
        const nearestOnset = Math.min(...analysis.onsets.map((onset) => Math.abs(onset.time - note.time)))
        expect(nearestOnset).toBeLessThan(0.08)
      }
    }
    expect(b.notes.length).toBeGreaterThan(a.notes.length * 0.6)
    expect(b.notes.length).toBeLessThan(a.notes.length * 1.6)
  })

  it('does not place notes during silence', () => {
    const truth = renderTestRhythm({ bpm: 128, bars: 12, leadInSeconds: 4, seed: 5 })
    const analysis = analyzeSamples(truth.samples, truth.sampleRate)
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    const chart = generateChart({
      analysis,
      timing,
      duration: truth.duration,
      songId: 'silence',
      difficulty: 'normal',
    })
    for (const note of chart.notes) {
      for (const region of analysis.silentRegions) {
        const inside = note.time > region.start && note.time < region.end
        expect(inside, `note at ${note.time.toFixed(2)}s inside silence ${region.start.toFixed(2)}-${region.end.toFixed(2)}`).toBe(false)
      }
    }
  })

  it('scales density with the target NPS override', () => {
    const { analysis, duration } = analyseDemo()
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    const sparse = generateChart({
      analysis,
      timing,
      duration,
      songId: 'demo',
      difficulty: 'hard',
      settings: { targetNps: 1.2, keepRatio: 0.4 },
    })
    const dense = generateChart({
      analysis,
      timing,
      duration,
      songId: 'demo',
      difficulty: 'hard',
      settings: { targetNps: 6, keepRatio: 0.95 },
    })
    expect(dense.stats.noteCount).toBeGreaterThan(sparse.stats.noteCount * 1.5)
  })
})

describe('beat line', () => {
  const textureWithBass = (bpm: number, startSeconds: number, seconds: number): SongTexture => {
    const rate = 43
    const bands = 12
    const data = new Uint8Array(Math.round(seconds * rate) * bands)
    const period = 60 / bpm
    for (let frame = 0; frame < data.length / bands; frame++) {
      const sinceHit = ((((frame / rate - startSeconds) % period) + period) % period)
      data[frame * bands] = sinceHit < period / 4 ? 200 : 80
    }
    return { rate, bands, data }
  }

  it('moves the beat onto the bass when the onsets picked the offbeat', () => {
    const period = 0.5
    const texture = textureWithBass(120, 0.25, 40)
    expect(settleBeatLine(texture, [], 120, 0, 40)).toBeCloseTo(period / 2, 5)
  })

  it('leaves the beat alone when the bass already agrees', () => {
    expect(settleBeatLine(textureWithBass(120, 0, 40), [], 120, 0, 40)).toBe(0)
  })
})

describe('repeated music', () => {
  it('groups the bars of a loop together', () => {
    const { analysis, duration } = analyseDemo()
    const groups = groupBars(analysis.onsets, TimingMap.single(analysis.bpm, analysis.offset), duration, analysis.texture)
    const bars = groups.groupOfBar.filter((group) => group >= 0).length
    expect(Math.max(...groups.members.map((members) => members.length))).toBeGreaterThanOrEqual(bars / 4)
  })

  it('gives the bars of a group the same rhythm and arrows, flipped or not', () => {
    const { analysis, duration } = analyseDemo()
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    const groups = groupBars(analysis.onsets, timing, duration, analysis.texture)
    for (const difficulty of ['normal', 'hard'] as const) {
      const chart = generateChart({ analysis, timing, duration, songId: 'demo', difficulty })
      const stepsPerBar = BAR_BEATS * chart.stepsPerBeat
      const barText = (bar: number, flip: boolean): string =>
        chart.notes
          .filter((note) => Math.floor(note.step / stepsPerBar) === bar)
          .map((note) => `${note.step - bar * stepsPerBar}:${flip ? 3 - note.lane : note.lane}`)
          .join(' ')
      let compared = 0
      let same = 0
      for (const members of groups.members) {
        for (const bar of members.slice(1)) {
          compared++
          const first = barText(members[0], groups.mirrored[members[0]])
          if (first === barText(bar, groups.mirrored[bar])) same++
        }
      }
      expect(compared).toBeGreaterThan(4)
      expect(same / compared).toBeGreaterThan(0.6)
    }
  })

  it('finds the tempo that makes the bars repeat when the detected one does not', () => {
    const truth = renderTestRhythm({ bpm: 84, bars: 24, leadInSeconds: 0.2, seed: 77 })
    const analysis = analyzeSamples(truth.samples, truth.sampleRate)
    const { onsets, texture } = analysis
    expect(tempoFromRepeats(onsets, texture!, truth.duration, analysis.bpm, analysis.offset)).toBeNull()
    const found = tempoFromRepeats(onsets, texture!, truth.duration, 110.5, 0)
    expect(found).not.toBeNull()
    expect([84, 168].some((bpm) => Math.abs(found! - bpm) < 1)).toBe(true)
  })
})

describe('hold notes', () => {
  it('turns sustained sounds into holds with grid-aligned tails, and leaves short blips as taps', () => {
    const timing = TimingMap.single(120, 0)
    const settings = resolveSettings('normal')
    const notes: ChartNote[] = []
    for (let i = 0; i < 8; i++) {
      const time = 1 + i * 1.5
      notes.push({
        id: `n${i}`,
        lane: 0,
        time,
        beat: timing.timeToBeat(time),
        step: timing.timeToStep(time, settings.stepsPerBeat),
        kind: 'tap',
        strength: 0.8,
      })
    }
    const sustains = new Map<number, number>(notes.map((note) => [Math.round(note.time * 1000), 1.4]))
    sustains.set(Math.round(notes[0].time * 1000), 0.2) // a drum-like blip
    const { notes: out, holds } = applyHolds(notes, timing, 30, settings, 'normal', 5, sustains)
    expect(out[0].kind).toBe('tap')
    expect(holds).toBeGreaterThan(0)
    expect(holds).toBeLessThanOrEqual(Math.max(1, Math.floor(out.length * 0.1)))
    for (const hold of out.filter((n) => n.kind === 'hold')) {
      const tail = hold.time + hold.duration!
      expect(hold.duration!).toBeGreaterThanOrEqual(0.24 - 1e-9)
      // Never longer than the sound itself (1.4 s here).
      expect(hold.duration!).toBeLessThanOrEqual(1.4 + 1e-9)
      // The tail sits on the 16th grid...
      const step = timing.timeToStep(tail, Math.max(4, settings.stepsPerBeat))
      expect(Math.abs(step - Math.round(step))).toBeLessThan(1e-6)
      // ...and clears the next note in the same lane.
      const next = out.find((n) => n.lane === hold.lane && n.time > hold.time + 1e-9)
      if (next) expect(next.time).toBeGreaterThan(tail + 0.12 - 1e-6)
    }
  })

  it('carries a ringing pad from the analyser to a hold note', () => {
    const truth = renderTestRhythm({ bpm: 120, bars: 12, leadInSeconds: 0.35, seed: 21, melody: false })
    const beatSeconds = 60 / truth.bpm
    const padStart = truth.offset + 8 * beatSeconds
    const padSeconds = 1.6
    // A sustained 220 Hz pad over a drum break: a sound with a clear attack that keeps ringing.
    // Human charts tap through a busy groove, so the drums stop for it.
    const start = Math.floor(padStart * truth.sampleRate)
    const length = Math.floor(padSeconds * truth.sampleRate)
    truth.samples.fill(0, start - Math.floor(0.05 * truth.sampleRate), start + length)
    for (let i = 0; i < length; i++) {
      const t = i / truth.sampleRate
      const attack = Math.min(1, t / 0.02)
      truth.samples[start + i] += Math.sin(2 * Math.PI * 220 * t) * 0.3 * attack
    }

    const analysis = analyzeSamples(truth.samples, truth.sampleRate)
    const atPad = analysis.onsets.filter((o) => Math.abs(o.time - padStart) < 0.12)
    expect(atPad.length, 'pad onset detected').toBeGreaterThan(0)
    // The pad rings until the next kick restrikes its band, one second later.
    expect(Math.max(...atPad.map((o) => o.heldSeconds ?? 0)), 'sustain measured').toBeGreaterThan(0.8)

    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    const chart = generateChart({ analysis, timing, duration: truth.duration, songId: 'pad', difficulty: 'expert' })
    const hold = chart.notes.find((n) => n.kind === 'hold' && Math.abs(n.time - padStart) < 0.15)
    expect(hold, 'the pad becomes a hold').toBeDefined()
    // The hold covers the pad until the next real hit, never past the sound by more than the
    // half a 16th its tail can move when it snaps to the grid.
    expect(hold!.duration!).toBeGreaterThan(0.3)
    expect(hold!.duration!).toBeLessThanOrEqual(1.6 + beatSeconds / 8 + 1e-9)
  })

  it('expert follows the music 1:1: nearly every selected candidate becomes an arrow', () => {
    const { analysis, duration } = analyseDemo()
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    const selection = selectCandidates(analysis, timing, duration, resolveSettings('expert'))
    const chart = generateChart({ analysis, timing, duration, songId: 'demo', difficulty: 'expert' })
    // Chords collapse several lanes onto one step, so compare steps, not notes.
    const chartSteps = new Set(chart.notes.map((n) => n.step))
    expect(chartSteps.size / selection.candidates.length).toBeGreaterThan(0.9)
  })

  it('rates the song from its full-density chart and keeps the ladder monotonic', () => {
    const { analysis, duration } = analyseDemo()
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    const charts = generateAllDifficulties({ analysis, timing, duration, songId: 'demo' })
    const rating = rateSong(charts)
    expect(rating).not.toBeNull()
    const expert = charts.find((c) => c.difficulty === 'expert')!
    expect(rating!.rating).toBe(expert.stats.rating)
    // A typical 128 BPM produced track should start the player on Hard, not drop them into the
    // full-density Expert chart just because it is the busiest chart we generated.
    expect(rating!.difficulty).toBe('hard')
    const counts = charts.map((c) => c.stats.noteCount)
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i], `${charts[i].difficulty} has at least as many notes as ${charts[i - 1].difficulty}`).toBeGreaterThanOrEqual(counts[i - 1])
    }
    expect(counts[counts.length - 1]).toBeGreaterThan(counts[0])
  })

  it('refuses to hold a lane that has no room before the next note', () => {
    const timing = TimingMap.single(120, 0)
    const notes: ChartNote[] = [
      { id: 'a', lane: 0, time: 1, beat: 2, step: 8, kind: 'tap', strength: 1 },
      { id: 'b', lane: 0, time: 1.15, beat: 2.3, step: 9, kind: 'tap', strength: 1 },
    ]
    const { notes: out, holds } = applyHolds(notes, timing, 30, resolveSettings('normal'), 'normal', 5)
    expect(holds).toBe(0)
    expect(out.every((n) => n.kind === 'tap')).toBe(true)
  })

  it('is deterministic for holds too', () => {
    const { analysis, duration } = analyseDemo()
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    const a = generateChart({ analysis, timing, duration, songId: 'demo', difficulty: 'hard' })
    const b = generateChart({ analysis, timing, duration, songId: 'demo', difficulty: 'hard' })
    const signature = (chart: typeof a): string[] => chart.notes.map((n) => `${n.kind}:${n.duration ?? 0}`)
    expect(signature(a)).toEqual(signature(b))
  })
})

describe('edit-aware generation (trim splice)', () => {
  it('never places notes outside the window or inside a removed section', () => {
    const { analysis, duration } = analyseDemo()
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    // Snap the cut to whole bars, exactly like the trim advisor does.
    const bar = (60 / analysis.bpm) * 4
    const cut = { start: Math.round(8 / bar) * bar, end: Math.round(12 / bar) * bar }
    const plan = buildEditPlan({ start: 1, end: duration - 2 }, [cut], duration)

    for (const chart of generateAllDifficulties({ analysis, timing, duration, songId: 'demo', edit: plan })) {
      expect(chart.notes.length, `${chart.difficulty} has notes`).toBeGreaterThan(0)
      for (const note of chart.notes) {
        expect(note.time).toBeGreaterThanOrEqual(plan.windowStart - 1e-6)
        expect(note.time).toBeLessThanOrEqual(plan.windowEnd + 1e-6)
        // There is no artificial ramp-in: the three-second countdown renders at negative song
        // time, so the first arrows can start exactly on the first onset of a trimmed window.
        expect(isCut(plan, note.time), `${chart.difficulty} note in the cut at ${note.time.toFixed(2)}s`).toBe(false)
        if (note.kind === 'hold') {
          const tail = note.time + note.duration!
          // No hold body may reach into removed audio: the clock jumps over it, so the tail
          // could never be held.
          for (const c of plan.cuts) {
            const crosses = note.time < c.end - 1e-6 && tail > c.start + 1e-6
            expect(crosses, `${chart.difficulty} hold ${note.time.toFixed(2)}–${tail.toFixed(2)} crosses cut ${c.start.toFixed(2)}–${c.end.toFixed(2)}`).toBe(false)
          }
          // ...and the tail stays on the subdivision grid for the `.sm` export.
          const step = timing.timeToStep(tail, chart.stepsPerBeat)
          expect(Math.abs(step - Math.round(step))).toBeLessThan(1e-6)
        }
      }
    }
  })

  it('clips hold tails at the boundary and downgrades what cannot fit', () => {
    const timing = TimingMap.single(120, 0) // 1/8 s steps at 4 steps per beat
    const plan = buildEditPlan({ start: 0, end: 20 }, [{ start: 8, end: 10 }], 30)
    const notes: ChartNote[] = [
      { id: 'a', lane: 0, time: 7.5, beat: 15, step: 60, kind: 'hold', strength: 1, duration: 1 }, // tail 8.5 → cut at 8
      { id: 'b', lane: 1, time: 7.875, beat: 15.75, step: 63, kind: 'hold', strength: 1, duration: 0.5 }, // tail 8.375 → only 0.125 left
      { id: 'c', lane: 2, time: 9, beat: 18, step: 72, kind: 'tap', strength: 1 }, // inside the cut
      { id: 'd', lane: 3, time: 25, beat: 50, step: 200, kind: 'tap', strength: 1 }, // past the window
      { id: 'e', lane: 0, time: 12, beat: 24, step: 96, kind: 'hold', strength: 1, duration: 1 }, // untouched
    ]
    const out = clipNotesToEdit(notes, plan, 30, timing, 4)
    expect(out.shortened).toBe(1)
    expect(out.downgraded).toBe(1)
    const byId = new Map(out.notes.map((n) => [n.id, n]))
    expect(byId.has('c')).toBe(false)
    expect(byId.has('d')).toBe(false)
    expect(byId.get('a')!.kind).toBe('hold')
    expect(byId.get('a')!.duration).toBeCloseTo(0.5, 9)
    expect(byId.get('b')!.kind).toBe('tap')
    expect(byId.get('b')!.duration).toBeUndefined()
    expect(byId.get('e')!.duration).toBeCloseTo(1, 9)
  })

  it('is deterministic with an edit plan', () => {
    const { analysis, duration } = analyseDemo()
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    const plan = buildEditPlan({ start: 2, end: duration - 1.5 }, [{ start: 10, end: 13.75 }], duration)
    const input = { analysis, timing, duration, songId: 'demo', difficulty: 'hard' as const, edit: plan }
    const signature = (chart: { notes: ChartNote[] }): string[] => chart.notes.map((n) => `${n.lane}@${n.time.toFixed(4)}:${n.kind}:${n.duration ?? 0}`)
    expect(signature(generateChart(input))).toEqual(signature(generateChart(input)))
  })
})

describe('following the singer', () => {
  const sung = (analysis: AnalysisResult, duration: number) => {
    const timing = TimingMap.single(analysis.bpm, analysis.offset)
    const beat = 60 / analysis.bpm
    const voice = []
    for (let k = 0; timing.beatToTime(4 + k * 1.5) < duration - 2; k++) {
      const late = k % 3 === 1 ? 0.06 : 0
      voice.push({ time: timing.beatToTime(4 + k * 1.5) + late, strength: 0.4 + (k % 2) * 0.3, band: 2, brightness: 0, heldSeconds: k % 4 === 0 ? beat * 2 : 0.15 })
    }
    return { timing, voice }
  }

  it('puts singer arrows only where the singer sings, keeping late notes late', () => {
    const { analysis, duration } = analyseDemo()
    const { timing, voice } = sung(analysis, duration)
    for (const difficulty of ['easy', 'expert'] as const) {
      const chart = generateChart({ analysis, timing, duration, songId: 'demo', difficulty, follow: 'singer', voice })
      expect(chart.notes.length).toBeGreaterThan(5)
      expect(chart.generator.follow).toBe('singer')
      for (const note of chart.notes) {
        expect(voice.some((v) => Math.abs(v.time - note.time) < 0.031)).toBe(true)
      }
      expect(validatePlayability(chart, duration).errors).toBe(0)
    }
    const expert = generateChart({ analysis, timing, duration, songId: 'demo', difficulty: 'expert', follow: 'singer', voice })
    const late = voice.filter((v) => Math.abs(timing.timeToBeat(v.time) * 4 - Math.round(timing.timeToBeat(v.time) * 4)) * (60 / analysis.bpm / 4) > 0.04)
    expect(late.length).toBeGreaterThan(0)
    expect(late.some((v) => expert.notes.some((n) => Math.abs(n.time - v.time) < 0.002))).toBe(true)
    expect(expert.notes.some((n) => n.kind === 'hold')).toBe(true)
  })

  it('mixes drums and voice for both, and falls back to the music without a voice', () => {
    const { analysis, duration } = analyseDemo()
    const { timing, voice } = sung(analysis, duration)
    const both = generateChart({ analysis, timing, duration, songId: 'demo', difficulty: 'hard', follow: 'both', voice })
    const onVoice = both.notes.filter((n) => voice.some((v) => Math.abs(v.time - n.time) < 0.031)).length
    expect(onVoice).toBeGreaterThan(0)
    expect(onVoice).toBeLessThan(both.notes.length)
    const music = generateChart({ analysis, timing, duration, songId: 'demo', difficulty: 'hard' })
    const fallback = generateChart({ analysis, timing, duration, songId: 'demo', difficulty: 'hard', follow: 'singer', voice: [] })
    expect(fallback.notes).toEqual(music.notes)
    expect(fallback.generator.follow).toBeUndefined()
  })
})
