/**
 * Chart timing: converting between seconds, beats and grid steps.
 *
 * The engine, the generator, the editor and the `.sm` exporter all route through this module so
 * there is exactly one definition of "where is beat 3.5".
 */
import type { BpmSegment, ChartNote, Timing } from '../core/types'
import { clamp } from '../core/math'

export const DEFAULT_STEPS_PER_BEAT = 4

/** Normalize/validate a timing map (sorts segments, drops nonsense values). */
export function normalizeTiming(timing: Timing): Timing {
  const bpms = [...timing.bpms]
    .filter((s) => Number.isFinite(s.beat) && Number.isFinite(s.bpm) && s.bpm > 0)
    .sort((a, b) => a.beat - b.beat)
  if (bpms.length === 0) bpms.push({ beat: 0, bpm: 120 })
  // Collapse duplicate beats, keeping the first.
  const deduped: BpmSegment[] = []
  for (const seg of bpms) {
    if (deduped.length > 0 && Math.abs(deduped[deduped.length - 1].beat - seg.beat) < 1e-6) continue
    deduped.push({ ...seg })
  }
  if (deduped[0].beat > 0) deduped.unshift({ beat: 0, bpm: deduped[0].bpm })
  return { offset: Number.isFinite(timing.offset) ? timing.offset : 0, bpms: deduped }
}

/** Immutable-ish timing helper. Cheap to build, safe to keep in React state. */
export class TimingMap {
  readonly offset: number
  readonly bpms: BpmSegment[]

  constructor(timing: Timing) {
    const normalized = normalizeTiming(timing)
    this.offset = normalized.offset
    this.bpms = normalized.bpms
  }

  static single(bpm: number, offset: number): TimingMap {
    return new TimingMap({ offset, bpms: [{ beat: 0, bpm }] })
  }

  get hasTempoChanges(): boolean {
    return this.bpms.length > 1
  }

  /** Tempo in effect at a given beat. */
  bpmAtBeat(beat: number): number {
    let bpm = this.bpms[0].bpm
    for (const seg of this.bpms) {
      if (seg.beat <= beat + 1e-9) bpm = seg.bpm
      else break
    }
    return bpm
  }

  /** Main tempo (the one with the largest span), used for display and defaults. */
  get primaryBpm(): number {
    if (this.bpms.length === 1) return this.bpms[0].bpm
    let best = this.bpms[0]
    let bestSpan = 0
    for (let i = 0; i < this.bpms.length; i++) {
      const end = i + 1 < this.bpms.length ? this.bpms[i + 1].beat : Number.POSITIVE_INFINITY
      const span = end - this.bpms[i].beat
      if (span > bestSpan) {
        bestSpan = span
        best = this.bpms[i]
      }
    }
    return best.bpm
  }

  /** Seconds per beat at a given beat position. */
  secondsPerBeat(beat: number): number {
    return 60 / this.bpmAtBeat(beat)
  }

  /** Song time (seconds) of a beat position. */
  beatToTime(beat: number): number {
    let time = this.offset
    for (let i = 0; i < this.bpms.length; i++) {
      const seg = this.bpms[i]
      if (seg.beat >= beat) break
      const nextBeat = i + 1 < this.bpms.length ? this.bpms[i + 1].beat : Number.POSITIVE_INFINITY
      const spanEnd = Math.min(beat, nextBeat)
      if (spanEnd > seg.beat) time += ((spanEnd - seg.beat) * 60) / seg.bpm
    }
    return time
  }

  /** Beat position of a song time (inverse of `beatToTime`). */
  timeToBeat(time: number): number {
    let remaining = time - this.offset
    let beat = 0
    for (let i = 0; i < this.bpms.length; i++) {
      const seg = this.bpms[i]
      const nextBeat = i + 1 < this.bpms.length ? this.bpms[i + 1].beat : Number.POSITIVE_INFINITY
      if (nextBeat === Number.POSITIVE_INFINITY) {
        return seg.beat + (remaining * seg.bpm) / 60
      }
      const spanSeconds = ((nextBeat - seg.beat) * 60) / seg.bpm
      if (remaining <= spanSeconds) {
        return seg.beat + (remaining * seg.bpm) / 60
      }
      remaining -= spanSeconds
      beat = nextBeat
    }
    return beat
  }

  /** Song time of a fractional grid step (step / stepsPerBeat = beats). */
  stepToTime(step: number, stepsPerBeat: number): number {
    return this.beatToTime(step / stepsPerBeat)
  }

  /** Grid step nearest to a song time. */
  timeToStep(time: number, stepsPerBeat: number): number {
    return Math.round(this.timeToBeat(time) * stepsPerBeat)
  }

  /** Quantize a song time onto the grid. */
  snapTime(time: number, stepsPerBeat: number): number {
    return this.stepToTime(this.timeToStep(time, stepsPerBeat), stepsPerBeat)
  }

  withBpm(bpm: number): TimingMap {
    return new TimingMap({ offset: this.offset, bpms: [{ beat: 0, bpm }] })
  }

  withOffset(offset: number): TimingMap {
    return new TimingMap({ offset, bpms: this.bpms.map((s) => ({ ...s })) })
  }

  /** Shift the whole grid in time by `delta` seconds (used by the offset calibration UI). */
  shifted(delta: number): TimingMap {
    return this.withOffset(this.offset + delta)
  }

  toJSON(): Timing {
    return { offset: this.offset, bpms: this.bpms.map((s) => ({ ...s })) }
  }
}

/**
 * Build the audible beat grid for a song, clipped to a duration.
 * `beatsPerBar` is only used by the editor/metronome.
 */
export function buildBeatGrid(timing: TimingMap, duration: number, beatsPerBar = 4): number[] {
  const spb = timing.secondsPerBeat(0)
  if (!Number.isFinite(spb) || spb <= 0) return []
  const beats: number[] = []
  const maxBeat = Math.max(0, timing.timeToBeat(duration) + beatsPerBar)
  for (let beat = 0; beat <= maxBeat; beat++) {
    const t = timing.beatToTime(beat)
    if (t > duration) break
    if (t >= 0) beats.push(t)
  }
  return beats
}

/** Sort notes by time then lane; guarantees the invariant the engine relies on. */
export function sortNotes(notes: ChartNote[]): ChartNote[] {
  return [...notes].sort((a, b) => (a.time === b.time ? a.lane - b.lane : a.time - b.time))
}

/** Clamp note times into the song and drop duplicates (same lane + same time). */
export function sanitizeNotes(notes: ChartNote[], duration: number): ChartNote[] {
  const seen = new Set<string>()
  const out: ChartNote[] = []
  for (const note of notes) {
    if (!Number.isFinite(note.time) || note.lane < 0 || note.lane > 3) continue
    const time = clamp(note.time, 0, Math.max(0, duration))
    const key = `${time.toFixed(4)}|${note.lane}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...note, time })
  }
  return sortNotes(out)
}
