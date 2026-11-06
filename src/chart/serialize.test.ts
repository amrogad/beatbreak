import { describe, expect, it } from 'vitest'
import { CHART_FILE_KIND, exportSm, parseChartFile, parseSmNoteRow, serializeChart } from './serialize'
import { TimingMap } from './timing'
import type { Chart, ChartNote, Difficulty, Lane } from '../core/types'

const timing = new TimingMap({ offset: 0.35, bpms: [{ beat: 0, bpm: 120 }] })

/** Note on the 16th grid: `step` is the position at 4 steps per beat. */
function note(lane: Lane, step: number, overrides: Partial<ChartNote> = {}): ChartNote {
  const beat = step / 4
  return {
    id: `l${lane}s${step}`,
    lane,
    time: timing.beatToTime(beat),
    beat,
    step,
    kind: 'tap',
    strength: 1,
    ...overrides,
  }
}

function makeChart(notes: ChartNote[], difficulty: Difficulty = 'normal'): Chart {
  return {
    schema: 1,
    id: 'chart_demo_normal',
    songId: 'demo',
    difficulty,
    title: 'Demo Song',
    timing: timing.toJSON(),
    stepsPerBeat: 4,
    notes,
    stats: { noteCount: notes.length, chordNotes: 0, peakNps: 2, avgNps: 1, rating: 5 },
    generator: {
      version: 'test-gen',
      source: 'analysis',
      seed: 7,
      notes: ['built for tests'],
      stepsPerBeat: 4,
      targetNps: 2,
      maxChord: 2,
      minJackGap: 0.2,
      keepRatio: 0.6,
      accent: 1,
    },
    edited: false,
    createdAt: 1000,
    updatedAt: 2000,
  }
}

const context = { title: 'Demo Song', artist: 'Test Artist', fileName: 'demo.wav', duration: 30 }

describe('PULSEGRID JSON export/import', () => {
  it('round-trips a chart without losing anything', () => {
    const chart = makeChart([note(0, 0), note(2, 4), note(3, 7), note(1, 15)])
    const text = serializeChart(chart, context)
    const parsed = parseChartFile(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.warnings).toEqual([])
    expect(parsed.chart.difficulty).toBe('normal')
    expect(parsed.chart.title).toBe('Demo Song')
    expect(parsed.chart.timing.offset).toBeCloseTo(0.35, 9)
    expect(parsed.chart.timing.bpms).toEqual([{ beat: 0, bpm: 120 }])
    expect(parsed.chart.notes.map((n) => `${n.lane}@${n.time.toFixed(4)}`)).toEqual(
      chart.notes.map((n) => `${n.lane}@${n.time.toFixed(4)}`),
    )
    expect(parsed.chart.stats.noteCount).toBe(4)
    expect(parsed.chart.generator.version).toBe('test-gen')
    expect(parsed.song.title).toBe('Demo Song')
    expect(parsed.song.fileName).toBe('demo.wav')
    expect((JSON.parse(text) as { kind: string }).kind).toBe(CHART_FILE_KIND)
  })

  it('accepts a bare chart object (no export wrapper)', () => {
    const parsed = parseChartFile(JSON.stringify(makeChart([note(0, 0)])))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.chart.songId).toBe('demo')
    expect(parsed.chart.notes).toHaveLength(1)
  })

  it('derives a missing step and beat from the timing map', () => {
    const raw = makeChart([note(0, 0)])
    const payload = {
      ...raw,
      notes: [{ id: 'x', lane: 1, time: timing.beatToTime(1), kind: 'tap', strength: 0.5 }],
    }
    const parsed = parseChartFile(JSON.stringify(payload))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.chart.notes[0].step).toBe(4)
    expect(parsed.chart.notes[0].beat).toBe(1)
  })

  it('rejects malformed files with a reason instead of throwing', () => {
    const invalidJson = parseChartFile('{nope')
    expect(invalidJson.ok).toBe(false)
    if (!invalidJson.ok) expect(invalidJson.error).toMatch(/not valid json/i)

    const empty = parseChartFile('{}')
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error).toMatch(/notes array/i)

    const wrongKind = parseChartFile(JSON.stringify({ kind: 'some-other-game', chart: makeChart([note(0, 0)]) }))
    expect(wrongKind.ok).toBe(false)
    if (!wrongKind.ok) expect(wrongKind.error).toMatch(/unsupported file kind/i)

    const noTiming = parseChartFile(JSON.stringify({ ...makeChart([note(0, 0)]), timing: { offset: 0, bpms: [] } }))
    expect(noTiming.ok).toBe(false)
    if (!noTiming.ok) expect(noTiming.error).toMatch(/timing map/i)

    const badBpm = parseChartFile(
      JSON.stringify({ ...makeChart([note(0, 0)]), timing: { offset: 0, bpms: [{ beat: 0, bpm: 4000 }] } }),
    )
    expect(badBpm.ok).toBe(false)
    if (!badBpm.ok) expect(badBpm.error).toMatch(/out of range/i)

    const noUsableNotes = parseChartFile(
      JSON.stringify({ ...makeChart([note(0, 0)]), notes: [{ lane: 9, time: 1 }] }),
    )
    expect(noUsableNotes.ok).toBe(false)
    if (!noUsableNotes.ok) expect(noUsableNotes.error).toMatch(/no usable notes/i)
  })

  it('drops duplicates and out-of-range notes with warnings', () => {
    const raw = makeChart([note(0, 0), note(0, 4), note(1, 8)])
    const file = {
      kind: CHART_FILE_KIND,
      version: 1,
      exportedAt: new Date(0).toISOString(),
      generator: 'test',
      song: { id: 'demo', title: 'Demo', artist: '', fileName: 'demo.wav', duration: 1.5 },
      chart: { ...raw, notes: [...raw.notes, { ...note(0, 4), id: 'duplicate' }, note(2, 64)] },
    }
    const parsed = parseChartFile(JSON.stringify(file))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.chart.notes).toHaveLength(3) // duplicate + past-the-end note gone
    expect(parsed.warnings.some((w) => /duplicate/i.test(w))).toBe(true)
    expect(parsed.warnings.some((w) => /end of the song/i.test(w))).toBe(true)
  })

  it('maps unknown difficulties onto Normal with a warning', () => {
    const parsed = parseChartFile(JSON.stringify({ ...makeChart([note(0, 0)]), difficulty: 'ultra-insane' }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.chart.difficulty).toBe('normal')
    expect(parsed.warnings.some((w) => /difficulty/i.test(w))).toBe(true)
  })
})

describe('StepMania .sm export', () => {
  it('writes a valid file where every note appears exactly once', () => {
    const chart = makeChart([note(0, 0), note(3, 4), note(1, 15), note(2, 16), note(0, 63)])
    const result = exportSm(chart, { title: 'Demo Song', artist: 'Test Artist', musicFileName: 'demo.ogg' })
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.text).toContain('#TITLE:Demo Song;')
    expect(result.text).toContain('#ARTIST:Test Artist;')
    expect(result.text).toContain('#MUSIC:demo.ogg;')
    expect(result.text).toContain('#OFFSET:-0.35;') // .sm counts the beat-0 offset backwards
    expect(result.text).toMatch(/#BPMS:0\.0=120\.0;/)
    expect(result.text).toMatch(/dance-single:\n\s+:\n\s+Medium:\n\s+5:/)

    const rows = result.text.split('\n').filter((line) => /^[0-3]{4}$/.test(line))
    expect(rows).toHaveLength(64) // ceil((63 + 1) / 16) = 4 measures × 16 rows
    expect(rows[0]).toBe('1000')
    expect(rows[4]).toBe('0001')
    expect(rows[63]).toBe('1000')
    const noteCount = rows.join('').split('').filter((ch) => ch !== '0').length
    expect(noteCount).toBe(5)
  })

  it('rounds notes that are off the .sm grid instead of refusing to export', () => {
    const offGrid: ChartNote = { id: 'og', lane: 2, time: 0.123, beat: 0, step: 0, kind: 'tap', strength: 0.5 }
    const result = exportSm(makeChart([note(0, 0), offGrid]), { title: 'T', artist: '', musicFileName: 'a.ogg' })
    expect(result.ok).toBe(true)
    expect(result.text).not.toBe('')
    expect(result.warnings.some((w) => /rounded/i.test(w))).toBe(true)
  })

  it('refuses an empty chart', () => {
    const result = exportSm(makeChart([]), { title: 'T', artist: '', musicFileName: 'a.ogg' })
    expect(result.ok).toBe(false)
    expect(result.errors).toContain('Chart has no notes.')
  })

  it('writes holds as a head and a tail row', () => {
    const chart = makeChart([note(0, 0, { kind: 'hold', duration: 1 }), note(1, 4)])
    const result = exportSm(chart, { title: 'T', artist: '', musicFileName: 'a.ogg' })
    expect(result.ok).toBe(true)
    const rows = result.text.split('\n').filter((line) => /^[0-3]{4}$/.test(line))
    expect(rows[0]).toBe('2000')
    expect(rows[4]).toBe('0100')
    expect(rows[8]).toBe('3000') // 1 s at 120 BPM = 2 beats = row 8
  })

  it('exports multi-segment BPM maps', () => {
    const chart = makeChart([
      { ...note(0, 0), time: 0 },
      { ...note(1, 32), beat: 8, time: 6 }, // beat 4 at 120 BPM = 2 s, then 4 beats at 60 BPM
    ])
    chart.timing = {
      offset: 0,
      bpms: [
        { beat: 0, bpm: 120 },
        { beat: 4, bpm: 60 },
      ],
    }
    const result = exportSm(chart, { title: 'T', artist: '', musicFileName: 'a.ogg' })
    expect(result.ok).toBe(true)
    expect(result.text).toMatch(/#BPMS:0\.0=120\.0,\s+4\.0=60\.0;/)
  })

  it('sanitizes header fields so the file stays parseable', () => {
    const result = exportSm(makeChart([note(0, 0)]), {
      title: 'My; Song\nX',
      artist: 'A:B',
      musicFileName: 'a;b.ogg',
    })
    expect(result.ok).toBe(true)
    expect(result.text).toContain('#TITLE:My Song X;')
    expect(result.text).toContain('#ARTIST:A B;')
    expect(result.text).toContain('#MUSIC:a b.ogg;')
  })

  it('parses .sm note rows back to lanes', () => {
    expect(parseSmNoteRow('L0D0')).toEqual([0, 1])
    expect(parseSmNoteRow('0000')).toEqual([])
    expect(parseSmNoteRow('r0u0')).toEqual([3, 2])
  })
})
