import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STEPS_PER_BEAT,
  TimingMap,
  buildBeatGrid,
  normalizeTiming,
  sanitizeNotes,
  sortNotes,
} from './timing'
import type { ChartNote, Lane } from '../core/types'

/** Minimal note factory: only lane and time matter for these tests. */
const note = (lane: Lane, time: number): ChartNote => ({
  id: `l${lane}-t${time}`,
  lane,
  time,
  beat: 0,
  step: 0,
  kind: 'tap',
  strength: 1,
})

describe('normalizeTiming', () => {
  it('sorts segments by beat and collapses duplicates, keeping the first', () => {
    const normalized = normalizeTiming({
      offset: 0.5,
      bpms: [
        { beat: 8, bpm: 150 },
        { beat: 0, bpm: 120 },
        { beat: 8, bpm: 999 },
      ],
    })
    expect(normalized.offset).toBe(0.5)
    expect(normalized.bpms).toEqual([
      { beat: 0, bpm: 120 },
      { beat: 8, bpm: 150 },
    ])
  })

  it('does not mutate the timing it was given', () => {
    const input = {
      offset: 0,
      bpms: [
        { beat: 4, bpm: 90 },
        { beat: 0, bpm: 140 },
      ],
    }
    const snapshot = JSON.stringify(input)
    normalizeTiming(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('drops nonsense segments and falls back to 120 BPM', () => {
    const normalized = normalizeTiming({
      offset: Number.NaN,
      bpms: [
        { beat: 0, bpm: -4 },
        { beat: Number.NaN, bpm: 130 },
        { beat: 2, bpm: Number.POSITIVE_INFINITY },
      ],
    })
    expect(normalized.offset).toBe(0)
    expect(normalized.bpms).toEqual([{ beat: 0, bpm: 120 }])
  })

  it('anchors the map at beat 0 when the first segment starts later', () => {
    const normalized = normalizeTiming({ offset: 0, bpms: [{ beat: 4, bpm: 90 }] })
    expect(normalized.bpms).toEqual([
      { beat: 0, bpm: 90 },
      { beat: 4, bpm: 90 },
    ])
  })
})

describe('TimingMap with a single tempo', () => {
  const timing = new TimingMap({ offset: 0.35, bpms: [{ beat: 0, bpm: 150 }] })

  it('converts beats to song time and back', () => {
    expect(timing.beatToTime(0)).toBeCloseTo(0.35, 9)
    expect(timing.beatToTime(4)).toBeCloseTo(1.95, 9) // 0.35 + 4 beats × 0.4 s
    for (const beat of [0, 0.25, 3, 17.5, 100]) {
      expect(timing.timeToBeat(timing.beatToTime(beat))).toBeCloseTo(beat, 9)
    }
  })

  it('handles times before the offset with negative beats', () => {
    const t = new TimingMap({ offset: 1, bpms: [{ beat: 0, bpm: 120 }] })
    expect(t.timeToBeat(0.75)).toBeCloseTo(-0.5, 9)
  })

  it('runs beats before the first tempo backwards, the inverse of timeToBeat', () => {
    const t = new TimingMap({ offset: 1, bpms: [{ beat: 0, bpm: 120 }] })
    expect(t.beatToTime(-0.5)).toBeCloseTo(0.75, 9)
    for (const time of [0, 0.3, 0.99]) expect(t.beatToTime(t.timeToBeat(time))).toBeCloseTo(time, 9)
  })

  it('maps integer steps to the grid', () => {
    expect(timing.stepToTime(0, 4)).toBeCloseTo(0.35, 9)
    expect(timing.stepToTime(8, 4)).toBeCloseTo(1.15, 9) // beat 2
    expect(timing.timeToStep(timing.stepToTime(13, 4), 4)).toBe(13)
  })

  it('snaps times onto the nearest 16th', () => {
    const t = new TimingMap({ offset: 0.5, bpms: [{ beat: 0, bpm: 120 }] })
    // Offset 0.5 s = beat 0; one 16th at 120 BPM = 0.125 s.
    expect(t.snapTime(0.5, 4)).toBeCloseTo(0.5, 9)
    expect(t.snapTime(0.51, 4)).toBeCloseTo(0.5, 9)
    expect(t.snapTime(0.68, 4)).toBeCloseTo(0.625, 9) // nearest 16th is 0.625, not 0.75
    expect(t.stepToTime(t.timeToStep(0.68, 4), 4)).toBeCloseTo(0.625, 9)
  })

  it('returns derived maps without touching the original', () => {
    const shifted = timing.shifted(0.05)
    const moved = timing.withOffset(2)
    const faster = timing.withBpm(200)
    expect(shifted.offset).toBeCloseTo(0.4, 9)
    expect(moved.offset).toBe(2)
    expect(faster.bpmAtBeat(0)).toBe(200)
    expect(timing.offset).toBeCloseTo(0.35, 9)
    expect(timing.bpmAtBeat(0)).toBe(150)
    expect(timing.timeToBeat(shifted.beatToTime(4))).not.toBeCloseTo(4, 6) // the grid really moved
  })

  it('has a stable default step resolution', () => {
    expect(DEFAULT_STEPS_PER_BEAT).toBe(4)
  })
})

describe('TimingMap with tempo changes', () => {
  const timing = new TimingMap({
    offset: 1,
    bpms: [
      { beat: 0, bpm: 120 },
      { beat: 4, bpm: 60 },
    ],
  })

  it('picks the tempo in effect at a beat, including on the boundary', () => {
    expect(timing.bpmAtBeat(0)).toBe(120)
    expect(timing.bpmAtBeat(3.999)).toBe(120)
    expect(timing.bpmAtBeat(4)).toBe(60)
    expect(timing.bpmAtBeat(100)).toBe(60)
    expect(timing.hasTempoChanges).toBe(true)
    expect(TimingMap.single(128, 0).hasTempoChanges).toBe(false)
  })

  it('converts beats across the tempo change and back', () => {
    expect(timing.beatToTime(0)).toBeCloseTo(1, 9)
    expect(timing.beatToTime(4)).toBeCloseTo(3, 9)
    expect(timing.beatToTime(8)).toBeCloseTo(7, 9) // 4 beats at 60 BPM = 4 s
    expect(timing.timeToBeat(3)).toBeCloseTo(4, 9)
    expect(timing.timeToBeat(7)).toBeCloseTo(8, 9)
    for (const beat of [0, 1, 3.5, 4.5, 12]) {
      expect(timing.timeToBeat(timing.beatToTime(beat))).toBeCloseTo(beat, 9)
    }
  })

  it('reports the open-ended last tempo segment as the primary BPM', () => {
    expect(timing.primaryBpm).toBe(60)
    expect(TimingMap.single(128, 0).primaryBpm).toBe(128)
  })
})

describe('buildBeatGrid', () => {
  it('lists every beat inside the song', () => {
    const grid = buildBeatGrid(TimingMap.single(120, 0), 3)
    expect(grid).toHaveLength(7) // 0.0 … 3.0 s at 0.5 s per beat
    expect(grid[0]).toBeCloseTo(0, 9)
    expect(grid[1]).toBeCloseTo(0.5, 9)
    expect(grid[6]).toBeCloseTo(3, 9)
  })

  it('skips beats that fall before the audio starts', () => {
    const grid = buildBeatGrid(TimingMap.single(120, -0.25), 2)
    expect(grid[0]).toBeCloseTo(0.25, 9)
  })
})

describe('sortNotes / sanitizeNotes', () => {
  it('orders by time, then by lane, returning a new array', () => {
    const input = [note(3, 1), note(0, 2), note(0, 1)]
    const sorted = sortNotes(input)
    expect(sorted.map((x) => `${x.time}:${x.lane}`)).toEqual(['1:0', '1:3', '2:0'])
    expect(input.map((x) => `${x.time}:${x.lane}`)).toEqual(['1:3', '2:0', '1:0']) // untouched
  })

  it('drops invalid notes, clamps to the song and removes duplicates', () => {
    const cleaned = sanitizeNotes(
      [
        note(2, 5), // clamped to the 4 s song
        note(0, 2),
        note(1, 2),
        { ...note(2, 5), id: 'duplicate' }, // same lane and time after clamping
        { ...note(0, 3), lane: 4 as unknown as Lane, id: 'bad-lane' },
        note(3, -1), // clamped to 0
        { ...note(0, 1), time: Number.NaN, id: 'bad-time' },
      ],
      4,
    )
    expect(cleaned.map((x) => `${x.time}:${x.lane}`)).toEqual(['0:3', '2:0', '2:1', '4:2'])
  })
})
