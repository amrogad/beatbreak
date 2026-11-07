/**
 * Plan clock: the maths that maps `AudioContext.currentTime` onto the original and edited
 * timelines while a multi-segment `PlaybackPlan` is sounding.
 *
 * Split out from the engine so it can be unit-tested without an AudioContext: the engine owns the
 * audio nodes, this file owns the arithmetic that decides *when* the player is hearing.
 */
import type { PlaybackPlan } from '../core/edit'

export interface ScheduledSegment {
  pbStart: number
  pbEnd: number
  origStart: number
  origEnd: number
  /** AudioContext time when this segment starts playing. */
  ctxStart: number
  /** AudioContext time when this segment finishes playing. */
  ctxEnd: number
}

/**
 * Nearest playable original-time position: an exact position inside a segment is kept (so pausing
 * and resuming is sample-exact), a position inside a removed interval snaps forward to the next
 * segment, and a position outside the window clamps to the window.
 */
export function snapIntoPlayback(plan: PlaybackPlan, origTime: number): number {
  const segments = plan.segments
  if (segments.length === 0) return 0
  const first = segments[0]
  const last = segments[segments.length - 1]
  if (!Number.isFinite(origTime) || origTime < first.origStart) return first.origStart
  if (origTime > last.origEnd) return last.origEnd
  const eps = 1e-6
  for (const segment of segments) {
    if (origTime < segment.origStart - eps) return segment.origStart
    if (origTime <= segment.origEnd + eps) {
      return Math.max(segment.origStart, Math.min(origTime, segment.origEnd))
    }
  }
  return last.origEnd
}

/** Edited-timeline position for an original-time position (used while paused). */
export function planTimeForSongTime(plan: PlaybackPlan, origTime: number): number {
  const segments = plan.segments
  if (segments.length === 0) return 0
  const eps = 1e-6
  for (const segment of segments) {
    if (origTime < segment.origStart - eps) return segment.pbStart
    if (origTime <= segment.origEnd + eps) {
      return segment.pbStart + Math.max(0, Math.min(origTime, segment.origEnd) - segment.origStart)
    }
  }
  return plan.duration
}

export class PlanClock {
  private segments: ScheduledSegment[] = []
  /** Original-time position reported before the first scheduled segment starts. */
  private fallbackOrig = 0

  schedule(segments: ScheduledSegment[], fallbackOrig: number): void {
    this.segments = segments
    this.fallbackOrig = fallbackOrig
  }

  clear(): void {
    this.segments = []
    this.fallbackOrig = 0
  }

  /** Original-timeline position of the audio being heard at `ctxNow`. Jumps across cuts. */
  songTimeAt(ctxNow: number): number {
    const segments = this.segments
    if (segments.length === 0) return this.fallbackOrig
    // During the scheduling lookahead nothing has sounded yet: report the start position.
    const now = Math.max(ctxNow, segments[0].ctxStart)
    for (const segment of segments) {
      if (now < segment.ctxEnd) {
        const length = segment.origEnd - segment.origStart
        return segment.origStart + Math.max(0, Math.min(now - segment.ctxStart, length))
      }
    }
    const last = segments[segments.length - 1]
    return last.origEnd
  }

  /**
   * Like `songTimeAt`, but runs on before the first segment and after the last one instead of
   * holding still. The judge clock maps a moment shifted by latency and calibration, which can sit
   * before the start or past the end while the audio is already (or still) playing.
   */
  songTimeAtUnclamped(ctxNow: number): number {
    const segments = this.segments
    if (segments.length === 0) return this.fallbackOrig
    const first = segments[0]
    if (ctxNow < first.ctxStart) return first.origStart - (first.ctxStart - ctxNow)
    const last = segments[segments.length - 1]
    if (ctxNow >= last.ctxEnd) return last.origEnd + (ctxNow - last.ctxEnd)
    return this.songTimeAt(ctxNow)
  }

  /** Edited-timeline position (continuous, counts only played audio). */
  planTimeAt(ctxNow: number): number {
    const segments = this.segments
    if (segments.length === 0) return 0
    const now = Math.max(ctxNow, segments[0].ctxStart)
    for (const segment of segments) {
      if (now < segment.ctxEnd) {
        const length = segment.pbEnd - segment.pbStart
        return segment.pbStart + Math.max(0, Math.min(now - segment.ctxStart, length))
      }
    }
    return segments[segments.length - 1].pbEnd
  }

  /** True once the last scheduled segment has finished sounding. */
  finishedAt(ctxNow: number): boolean {
    if (this.segments.length === 0) return true
    return ctxNow >= this.segments[this.segments.length - 1].ctxEnd - 1e-3
  }
}

/**
 * `AudioContext.currentTime` moves in jumps: the audio thread renders a whole device buffer at
 * once (about 10 ms on Windows, more on phones) and the clock stands still in between, so a raw
 * reading is up to one buffer late, at random. This draws a straight line through the tops of
 * those steps with `performance.now()`, then shifts it down by the average gap so it sits where
 * the raw clock sits on average: calibrations made on the stepped clock still hold.
 */
export class SmoothClock {
  /** Context seconds minus performance seconds along the line through the step tops. */
  private offset = Number.NaN
  private lastRaw = -Infinity
  private lastAt = 0
  private lastOut = -Infinity
  /** Running average of how far the line sits above the raw clock. */
  private lead = 0

  /**
   * @param maxLead   furthest the line may run ahead of the raw clock before it counts as stalled
   * @param sagPerSecond how fast the line lets itself fall back, so a slower audio clock is followed
   */
  constructor(
    private readonly maxLead = 0.08,
    private readonly sagPerSecond = 0.0005,
  ) {}

  read(raw: number, nowMs: number): number {
    const now = nowMs / 1000
    if (Number.isNaN(this.offset) || raw < this.lastRaw) {
      // First reading, or a different context.
      this.offset = raw - now
      this.lead = 0
      this.lastOut = -Infinity
    } else {
      this.offset -= Math.max(0, now - this.lastAt) * this.sagPerSecond
      // The audio clock is never behind its latest reading.
      this.offset = Math.max(this.offset, raw - now)
    }
    this.lastRaw = raw
    this.lastAt = now
    let line = now + this.offset
    if (line - raw > this.maxLead) {
      // The audio clock stopped (suspended, an underrun): start the line again from it.
      this.offset = raw - now
      line = raw
    } else {
      this.lead += (line - raw - this.lead) * 0.02
    }
    this.lastOut = Math.max(this.lastOut, line - this.lead)
    return this.lastOut
  }
}
