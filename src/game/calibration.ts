/**
 * Audio sync from a tap-along: the player taps with a steady click, and the median delay of those
 * taps (behind the moment the click left the audio graph) is their speakers' latency plus their
 * own habit. Judging already subtracts the latency the browser reports, so the setting covers
 * the rest. Bluetooth headphones often report nothing and add 150-300 ms; this is how they get fixed.
 */
import { arrowOffsetMs } from '../store/settings'

/** Taps further than this from any click are a slip, not a measurement. */
export const CALIBRATION_MAX_MS = 350
/** The first taps are the player finding the beat. */
export const CALIBRATION_WARMUP = 4
export const CALIBRATION_MIN_TAPS = 8

export interface CalibrationResult {
  /** The value for Settings > Audio sync. */
  audioOffsetMs: number
  /** Median tap delay behind the click, in ms. */
  delayMs: number
  /** How steady the taps were (median distance from the median), in ms. */
  spreadMs: number
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * @param tapDelaysMs each tap's time minus the nearest click's graph time, in tap order
 * @param reportedLatencyMs the output latency the engine will subtract while playing
 */
export function calibrate(tapDelaysMs: number[], reportedLatencyMs: number): CalibrationResult | null {
  const taps = tapDelaysMs.slice(CALIBRATION_WARMUP).filter((d) => Number.isFinite(d) && Math.abs(d) <= CALIBRATION_MAX_MS)
  if (taps.length < CALIBRATION_MIN_TAPS) return null
  const delayMs = median(taps)
  const spreadMs = median(taps.map((d) => Math.abs(d - delayMs)))
  // The engine judges at graph time - latency - offset; the taps say "heard" = graph + delay.
  // So the offset the engine needs is delay - latency, and the stored setting is that minus the
  // built-in display lead (see arrowOffsetMs).
  const engineOffset = delayMs - reportedLatencyMs
  const audioOffsetMs = Math.round(engineOffset - arrowOffsetMs(0))
  return { audioOffsetMs: Math.max(-250, Math.min(250, audioOffsetMs)), delayMs: Math.round(delayMs), spreadMs: Math.round(spreadMs) }
}
