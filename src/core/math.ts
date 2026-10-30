/** Small numeric helpers shared by the DSP, tempo, chart and scoring modules. */

export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v)

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export const mean = (values: ArrayLike<number>): number => {
  if (values.length === 0) return 0
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i]
  return sum / values.length
}

export const stdDev = (values: ArrayLike<number>, mu = mean(values)): number => {
  if (values.length < 2) return 0
  let acc = 0
  for (let i = 0; i < values.length; i++) {
    const d = values[i] - mu
    acc += d * d
  }
  return Math.sqrt(acc / (values.length - 1))
}

/** Linear-interpolated quantile of an unsorted array (copies, then sorts). */
export function quantile(values: ArrayLike<number>, q: number): number {
  if (values.length === 0) return 0
  const sorted = Array.from(values).sort((a, b) => a - b)
  const pos = clamp(q, 0, 1) * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return lo === hi ? sorted[lo] : lerp(sorted[lo], sorted[hi], pos - lo)
}

/** Sample a signal at fractional index with linear interpolation, clamped at the edges. */
export function sampleAt(signal: ArrayLike<number>, index: number): number {
  if (signal.length === 0) return 0
  if (index <= 0) return signal[0]
  if (index >= signal.length - 1) return signal[signal.length - 1]
  const i = Math.floor(index)
  const frac = index - i
  return lerp(signal[i], signal[i + 1], frac)
}

/** Trailing moving average over a window of `radius` samples on both sides (centred). */
export function movingAverage(signal: ArrayLike<number>, radius: number): Float32Array {
  const n = signal.length
  const out = new Float32Array(n)
  if (radius <= 0 || n === 0) {
    for (let i = 0; i < n; i++) out[i] = signal[i]
    return out
  }
  let sum = 0
  let count = 0
  // Prime the window [0, radius]
  for (let i = 0; i <= Math.min(radius, n - 1); i++) {
    sum += signal[i]
    count++
  }
  for (let i = 0; i < n; i++) {
    out[i] = count > 0 ? sum / count : 0
    const add = i + radius + 1
    const drop = i - radius
    if (add < n) {
      sum += signal[add]
      count++
    }
    if (drop >= 0) {
      sum -= signal[drop]
      count--
    }
  }
  return out
}

/** Normalize to 0..1 by the maximum value; returns zeros for silent input. */
export function normalize(signal: Float32Array): Float32Array {
  let max = 0
  for (let i = 0; i < signal.length; i++) if (signal[i] > max) max = signal[i]
  const out = new Float32Array(signal.length)
  if (max <= 1e-9) return out
  const inv = 1 / max
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] * inv
  return out
}

/** Downsample a signal into `buckets` peak values scaled to 0..255 (waveform display). */
export function toPeakBytes(signal: Float32Array, buckets: number): Uint8Array {
  const out = new Uint8Array(buckets)
  if (signal.length === 0 || buckets === 0) return out
  const per = signal.length / buckets
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * per)
    const end = Math.max(start + 1, Math.min(signal.length, Math.floor((b + 1) * per)))
    let peak = 0
    for (let i = start; i < end; i++) {
      const v = Math.abs(signal[i])
      if (v > peak) peak = v
    }
    out[b] = Math.round(clamp(peak, 0, 1) * 255)
  }
  return out
}

/** Downsample a signal into `buckets` mean values (envelope display / scoring). */
export function downsample(signal: ArrayLike<number>, buckets: number): Float32Array {
  const out = new Float32Array(buckets)
  if (signal.length === 0 || buckets === 0) return out
  const per = signal.length / buckets
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * per)
    const end = Math.max(start + 1, Math.min(signal.length, Math.floor((b + 1) * per)))
    let sum = 0
    for (let i = start; i < end; i++) sum += signal[i]
    out[b] = sum / (end - start)
  }
  return out
}
