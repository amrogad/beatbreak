/**
 * Judgement and timing windows.
 *
 * Windows are symmetric around the note time and defined in milliseconds, StepMania-style:
 * Marvelous / Perfect / Great / Good are the hit tiers, and anything beyond the Good window is
 * a Miss. A tap is attributed to the closest unjudged note in the same lane within
 * `windows.good`; anything further away is ignored (the tap is not consumed) so mashing never
 * steals a note that is still far in the future.
 *
 * Boundary rule: a delta exactly on a window edge counts as the *tighter* tier (<=, not <), and
 * tests assert this explicitly so gameplay and scoring can never disagree.
 */
import type { Judgment, JudgmentWindows } from '../core/types'

/**
 * The default windows, well inside StepMania's (Good ends at 80 ms instead of 135 ms):
 * with wider windows early presses counted and the game played too easy.
 */
export const DEFAULT_WINDOWS: JudgmentWindows = {
  marvelous: 15,
  perfect: 33,
  great: 60,
  good: 80,
  missAfter: 80,
}

/** The four hit windows a player can set by hand; `missAfter` always follows `good`. */
export interface CustomWindows {
  marvelous: number
  perfect: number
  great: number
  good: number
}

export type WindowPreset = 'strict' | 'standard' | 'stepmania' | 'lenient' | 'custom'

export const WINDOW_PRESETS: Record<Exclude<WindowPreset, 'custom'>, JudgmentWindows> = {
  strict: { marvelous: 10, perfect: 22, great: 40, good: 55, missAfter: 55 },
  standard: DEFAULT_WINDOWS,
  /**
   * StepMania's own windows (`TimingWindowSecondsInit` in Player.cpp): W1 22.5 ms, W2 45 ms,
   * W3 90 ms, W4 135 ms. The same values StepMania ships with in dance mode.
   */
  stepmania: { marvelous: 22.5, perfect: 45, great: 90, good: 135, missAfter: 135 },
  lenient: { marvelous: 22, perfect: 55, great: 105, good: 155, missAfter: 155 },
}

/** Clamp and force a hand-set window set into order (marvelous ≤ perfect ≤ great ≤ good). */
export function normalizeCustomWindows(custom: Partial<CustomWindows> | undefined): CustomWindows {
  const clamp = (value: unknown, fallback: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
    return Math.round(Math.max(4, Math.min(300, n)))
  }
  const marvelous = clamp(custom?.marvelous, DEFAULT_WINDOWS.marvelous)
  const perfect = Math.max(marvelous, clamp(custom?.perfect, DEFAULT_WINDOWS.perfect))
  const great = Math.max(perfect, clamp(custom?.great, DEFAULT_WINDOWS.great))
  const good = Math.max(great, clamp(custom?.good, DEFAULT_WINDOWS.good))
  return { marvelous, perfect, great, good }
}

/**
 * The windows for a run. Every difficulty uses the preset as defined, the way StepMania does;
 * the player's audio-offset calibration is applied by the engine, not by widening the windows.
 * A hand-set ("custom") window set is used exactly as entered.
 */
/**
 * Touch screens get windows this much wider than the preset, since tapping glass is harder than
 * pressing keys. 1.5x puts the standard
 * preset at roughly StepMania's own windows.
 */
export const TOUCH_WINDOW_SCALE = 1.5

export function judgmentWindows(
  preset: WindowPreset,
  custom?: Partial<CustomWindows>,
  touch = false,
): JudgmentWindows {
  if (preset === 'custom') {
    const normalized = normalizeCustomWindows(custom)
    return { ...normalized, missAfter: normalized.good }
  }
  const base = WINDOW_PRESETS[preset]
  const scale = touch ? TOUCH_WINDOW_SCALE : 1
  if (scale === 1) return { ...base }
  return {
    marvelous: Math.round(base.marvelous * scale),
    perfect: Math.round(base.perfect * scale),
    great: Math.round(base.great * scale),
    good: Math.round(base.good * scale),
    missAfter: Math.round(base.missAfter * scale),
  }
}

/** Judgment for a signed timing delta in milliseconds (negative = early). */
export function judge(deltaMs: number, windows: JudgmentWindows): Judgment {
  const abs = Math.abs(deltaMs)
  if (abs <= windows.marvelous) return 'marvelous'
  if (abs <= windows.perfect) return 'perfect'
  if (abs <= windows.great) return 'great'
  if (abs <= windows.good) return 'good'
  return 'miss'
}

/** Whether a tap at this delta is close enough to consume the note. */
export function isWithinHitWindow(deltaMs: number, windows: JudgmentWindows): boolean {
  return Math.abs(deltaMs) <= windows.good
}

/** Whether a note that has been passed by `deltaMs` should now be counted as missed. */
export function isMissed(deltaMs: number, windows: JudgmentWindows): boolean {
  return deltaMs > windows.missAfter
}

/** Relative weight of a judgment, used for accuracy. */
export const JUDGMENT_WEIGHT: Record<Judgment, number> = {
  marvelous: 1,
  perfect: 0.9,
  great: 0.72,
  good: 0.45,
  miss: 0,
}

export const JUDGMENT_LABEL: Record<Judgment, string> = {
  marvelous: 'Marvelous',
  perfect: 'Perfect',
  great: 'Great',
  good: 'Good',
  miss: 'Miss',
}

/** The same colours the playfield uses for each judgment. */
export const JUDGMENT_COLOR: Record<Judgment, string> = {
  marvelous: '#3de9ff',
  perfect: '#ffc93d',
  great: '#3fe08a',
  good: '#b35cff',
  miss: '#ff4f9a',
}

/** A tap that is early/late but still a hit gives feedback text in the combo area. */
export function timingLabel(deltaMs: number): string {
  if (Math.abs(deltaMs) < 1) return 'on time'
  return deltaMs < 0 ? 'early' : 'late'
}

/**
 * Convert a raw key timestamp to "song time" for judging.
 *
 * The audio clock is the only trustworthy time source during gameplay; `event.timeStamp` gives us
 * the moment the input actually happened (rather than when React happened to run), which removes
 * most of the jitter caused by a busy main thread.
 *
 * @param eventTimeMs  performance.now()-based timestamp from the input event
 * @param audioSongTimeMs song position derived from AudioContext.currentTime at the same moment
 * @param nowMs        performance.now() at the moment we read the audio clock
 */
export function compensateInputLatency(
  eventTimeMs: number,
  audioSongTimeMs: number,
  nowMs: number,
  latencyMs = 0,
): number {
  const lag = nowMs - eventTimeMs
  // The audio clock is read when the handler runs, so a busy main thread makes it late by the
  // whole lag. Only a negative or absurd lag (a timestamp on another clock) is ignored.
  const trustedLag = lag >= 0 && lag <= 150 ? lag : 0
  return audioSongTimeMs - trustedLag - latencyMs
}
