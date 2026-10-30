/**
 * The edit map: how the *playable* timeline relates to the original audio file.
 *
 * A song edit is a window `[start, end]` plus zero or more removed intervals ("cuts"). Playback
 * is the concatenation of the kept segments, so a cut works like a splice: the music continues
 * from the end of the cut as if the removed part had never been there.
 *
 * Why cuts must sit on bar lines (enforced by the trim advisor, not here): if a cut removes a
 * whole number of bars, the beat grid is continuous across the splice, so the tempo map carries
 * over unchanged and generated charts stay perfectly on-grid after the join. The BPM-segment
 * structure itself never needs rewriting — a cut only shifts *time*, and by a multiple of the
 * bar length at that point.
 *
 * The engine plays back `PlaybackPlan`s; the chart generator maps note candidates through the
 * same `EditPlan`, so what is heard and what is charted can never disagree.
 */

export interface EditWindow {
  start: number
  end: number
}

export interface EditCut {
  /** Seconds in the original audio; always inside the window. */
  start: number
  end: number
}

export interface EditSegment {
  origStart: number
  origEnd: number
  /** Position where this segment starts on the edited (playback) timeline. */
  pbStart: number
}

export interface EditPlan {
  origDuration: number
  windowStart: number
  windowEnd: number
  /** Sorted, non-overlapping, inside the window. */
  cuts: EditCut[]
  segments: EditSegment[]
  /** Length of the edited timeline in seconds. */
  duration: number
}

/** Shortest piece of audio worth keeping between two cuts (gluing stubs is worse than keeping them). */
const MIN_SEGMENT = 0.5

/** Clamp a window and drop nonsense; a window that leaves almost nothing becomes the whole song. */
export function normalizeEditWindow(window: EditWindow | null | undefined, duration: number): EditWindow {
  if (!window || !Number.isFinite(window.start) || !Number.isFinite(window.end)) return { start: 0, end: duration }
  const start = Math.max(0, Math.min(window.start, duration))
  const end = Math.max(0, Math.min(window.end, duration))
  if (end - start < 1) return { start: 0, end: duration }
  return { start, end }
}

/** Clamp cuts into the window, drop tiny/overlapping ones, sort. */
export function normalizeEditCuts(
  cuts: EditCut[] | null | undefined,
  window: EditWindow,
  minCut = 0.35,
): EditCut[] {
  if (!cuts || cuts.length === 0) return []
  const cleaned = cuts
    .filter((cut) => Number.isFinite(cut.start) && Number.isFinite(cut.end) && cut.end > cut.start)
    .map((cut) => ({
      start: Math.max(window.start, Math.min(cut.start, window.end)),
      end: Math.max(window.start, Math.min(cut.end, window.end)),
    }))
    .filter((cut) => cut.end - cut.start >= minCut)
    .sort((a, b) => a.start - b.start)
  const merged: EditCut[] = []
  for (const cut of cleaned) {
    const last = merged[merged.length - 1]
    if (last && cut.start <= last.end + 0.05) {
      last.end = Math.max(last.end, cut.end)
    } else {
      merged.push({ ...cut })
    }
  }
  return merged
}

export function buildEditPlan(
  window: EditWindow,
  cuts: EditCut[] | null | undefined,
  duration: number,
): EditPlan {
  const w = normalizeEditWindow(window, duration)
  const normalized = normalizeEditCuts(cuts, w)

  const segments: EditSegment[] = []
  let cursor = w.start
  let pb = 0
  const push = (origStart: number, origEnd: number): void => {
    if (origEnd - origStart <= 1e-6) return
    segments.push({ origStart, origEnd, pbStart: pb })
    pb += origEnd - origStart
  }

  for (const cut of normalized) {
    // Skip cuts that would leave a useless fragment before them.
    if (cut.start - cursor < MIN_SEGMENT) continue
    push(cursor, cut.start)
    cursor = cut.end
  }
  push(cursor, w.end)

  return {
    origDuration: duration,
    windowStart: w.start,
    windowEnd: w.end,
    cuts: normalized,
    segments,
    duration: segments.reduce((total, segment) => total + (segment.origEnd - segment.origStart), 0),
  }
}

/** Full-song plan (no window, no cuts). */
export function fullEditPlan(duration: number): EditPlan {
  return buildEditPlan({ start: 0, end: duration }, [], duration)
}

/** True when `origTime` falls inside one of the removed intervals. */
export function isCut(plan: EditPlan, origTime: number): boolean {
  for (const cut of plan.cuts) {
    if (origTime >= cut.start && origTime < cut.end) return true
  }
  return false
}

/**
 * Map an original-audio time onto the edited timeline.
 * Returns null when the time was removed by a cut or lies outside the window.
 */
export function toPlayback(plan: EditPlan, origTime: number): number | null {
  if (origTime < plan.windowStart - 1e-9 || origTime > plan.windowEnd + 1e-9) return null
  for (const segment of plan.segments) {
    if (origTime >= segment.origStart - 1e-9 && origTime <= segment.origEnd + 1e-9) {
      return segment.pbStart + (Math.min(origTime, segment.origEnd) - segment.origStart)
    }
  }
  return null
}

/** Map an edited-timeline time back to original audio. Always defined inside [0, duration]. */
export function toOriginal(plan: EditPlan, pbTime: number): number {
  const t = Math.max(0, Math.min(pbTime, plan.duration))
  for (const segment of plan.segments) {
    const length = segment.origEnd - segment.origStart
    if (t <= segment.pbStart + length + 1e-9) {
      return segment.origStart + Math.max(0, t - segment.pbStart)
    }
  }
  return plan.windowEnd
}

/** Edited position for seeking to an original time that may sit inside a cut (snaps to the join). */
export function nearestPlayback(plan: EditPlan, origTime: number): number {
  const direct = toPlayback(plan, origTime)
  if (direct !== null) return direct
  for (const segment of plan.segments) {
    if (origTime < segment.origStart) return segment.pbStart
  }
  return plan.duration
}

/**
 * The tempo map of the edited timeline: the original map shifted by the window start.
 * (Cuts remove whole bars, so they never change the phase of the grid.)
 */
export function playbackTimingOffset(plan: EditPlan, originalOffset: number): number {
  return originalOffset - plan.windowStart
}

/* --------------------------------------------------------------- engine plan */

export interface PlaybackSegment {
  /** Edited-timeline position where this segment begins. */
  pbStart: number
  pbEnd: number
  /** Offset into the audio buffer where the segment starts. */
  origStart: number
  origEnd: number
}

export interface PlaybackPlan {
  duration: number
  segments: PlaybackSegment[]
}

export function toPlaybackPlan(plan: EditPlan): PlaybackPlan {
  return {
    duration: plan.duration,
    segments: plan.segments.map((segment) => ({
      pbStart: segment.pbStart,
      pbEnd: segment.pbStart + (segment.origEnd - segment.origStart),
      origStart: segment.origStart,
      origEnd: segment.origEnd,
    })),
  }
}

/** Plan for a buffer played straight through (used by tests and simple previews). */
export function fullSongPlan(duration: number): PlaybackPlan {
  return { duration, segments: [{ pbStart: 0, pbEnd: duration, origStart: 0, origEnd: duration }] }
}

/** Edit plan for a stored song: the window/cuts it carries, or the whole file when untrimmed. */
export function planForMeta(meta: {
  duration: number
  trimStart?: number
  trimEnd?: number
  trimCuts?: { start: number; end: number }[]
}): EditPlan {
  return buildEditPlan(
    { start: meta.trimStart ?? 0, end: meta.trimEnd ?? meta.duration },
    meta.trimCuts ?? [],
    meta.duration,
  )
}
