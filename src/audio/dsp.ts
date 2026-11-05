/**
 * Digital signal processing primitives used by the chart generator.
 *
 * Deliberately dependency free and pure: every function here is deterministic, takes plain
 * typed arrays and can run inside a Web Worker or a Node test process.
 */

/** In-place iterative radix-2 FFT (split-radix style Cooley–Tukey on real→complex input). */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  if (n !== im.length || (n & (n - 1)) !== 0) throw new Error('fft: length must be a power of two')

  // Bit reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wRe = Math.cos(ang)
    const wIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k]
        const uIm = im[i + k]
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe
        re[i + k] = uRe + vRe
        im[i + k] = uIm + vIm
        re[i + k + len / 2] = uRe - vRe
        im[i + k + len / 2] = uIm - vIm
        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size)
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)))
  return w
}

/** Next power of two ≥ value. */
export const nextPow2 = (value: number): number => {
  let p = 1
  while (p < value) p <<= 1
  return p
}

export interface StftOptions {
  /** Analysis frame size in samples (power of two). */
  frameSize: number
  /** Hop size in samples. */
  hopSize: number
  /** Number of log-spaced bands used for the per-band flux. */
  bands: number
}

export interface StftResult {
  /** frames × bins magnitude spectra, frame-major. */
  magnitude: Float32Array
  frames: number
  bins: number
  frameRate: number
  /** Band index for each FFT bin. */
  bandOfBin: Int32Array
  bandCount: number
}

export function computeStft(
  samples: Float32Array,
  sampleRate: number,
  options: StftOptions,
  onProgress?: (fraction: number) => void,
): StftResult {
  const { frameSize, hopSize, bands } = options
  const bins = frameSize / 2 + 1
  const frames = Math.max(1, Math.floor((samples.length - frameSize) / hopSize) + 1)
  const magnitude = new Float32Array(frames * bins)
  const window = hannWindow(frameSize)
  const re = new Float32Array(frameSize)
  const im = new Float32Array(frameSize)

  for (let f = 0; f < frames; f++) {
    const offset = f * hopSize
    for (let i = 0; i < frameSize; i++) {
      const s = offset + i
      re[i] = (s < samples.length ? samples[s] : 0) * window[i]
      im[i] = 0
    }
    fft(re, im)
    const base = f * bins
    for (let k = 0; k < bins; k++) {
      magnitude[base + k] = Math.hypot(re[k], im[k])
    }
    if (onProgress && (f & 127) === 0) onProgress(f / frames)
  }
  onProgress?.(1)

  // Log-spaced bands from ~40 Hz to Nyquist.
  const nyquist = sampleRate / 2
  const minHz = 40
  const bandOfBin = new Int32Array(bins)
  const edges: number[] = []
  for (let b = 0; b <= bands; b++) {
    const t = b / bands
    edges.push(minHz * Math.pow(nyquist / minHz, t))
  }
  for (let k = 0; k < bins; k++) {
    const hz = (k * sampleRate) / frameSize
    let band = 0
    while (band < bands - 1 && hz >= edges[band + 1]) band++
    bandOfBin[k] = band
  }

  return { magnitude, frames, bins, frameRate: sampleRate / hopSize, bandOfBin, bandCount: bands }
}

export interface OnsetEnvelopes {
  /** Overall onset strength (spectral flux, log-compressed, adaptively normalized). */
  flux: Float32Array
  /** Per-band onset strength, normalized. */
  bandFlux: Float32Array[]
  /** RMS energy envelope (not onset-shaped; used for section detection). */
  rms: Float32Array
  /** Short-term energy onset (positive RMS difference), normalized. */
  energyFlux: Float32Array
  frames: number
  frameRate: number
}

/**
 * Spectral flux onset detection (Böck et al. style):
 *
 *  onset[f] = Σ_k H(|X[f,k]| − |X[f−1,k]|)  using log-compressed magnitudes so that quiet
 *  passages still contribute, plus a parallel RMS energy flux. The two are combined and then
 *  high-pass filtered with a local moving average so slow dynamics don't swamp the peaks.
 */
export function computeOnsetEnvelopes(
  samples: Float32Array,
  sampleRate: number,
  stft: StftResult,
  options: { frameSize: number; hopSize: number; bands: number; compression?: number },
): OnsetEnvelopes {
  const { magnitude, frames, bins, bandOfBin, bandCount } = stft
  const compression = options.compression ?? 900
  const logScale = (v: number): number => Math.log1p(compression * v)

  const flux = new Float32Array(frames)
  const bandFlux: Float32Array[] = []
  for (let b = 0; b < bandCount; b++) bandFlux.push(new Float32Array(frames))

  let prev = new Float32Array(bins)
  for (let f = 0; f < frames; f++) {
    const base = f * bins
    let total = 0
    for (let k = 0; k < bins; k++) {
      const cur = logScale(magnitude[base + k])
      const diff = cur - prev[k]
      if (diff > 0) {
        total += diff
        bandFlux[bandOfBin[k]][f] += diff
      }
    }
    flux[f] = total
    // Re-read magnitudes for the next frame's previous vector (log compressed).
    for (let k = 0; k < bins; k++) prev[k] = logScale(magnitude[base + k])
  }
  prev = new Float32Array(bins) // release

  // RMS per frame from the time-domain signal.
  const { frameSize, hopSize } = options
  const rms = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    const start = f * hopSize
    let acc = 0
    let count = 0
    for (let i = 0; i < frameSize; i += 2) {
      const s = start + i
      if (s >= samples.length) break
      const v = samples[s]
      acc += v * v
      count++
    }
    rms[f] = count > 0 ? Math.sqrt(acc / count) : 0
  }

  const energyFlux = new Float32Array(frames)
  for (let f = 1; f < frames; f++) {
    const d = rms[f] - rms[f - 1]
    energyFlux[f] = d > 0 ? d : 0
  }

  // Adaptive normalization: subtract a ~0.4 s moving average and rectify, then scale to 0..1.
  const radius = Math.max(2, Math.round(0.4 * stft.frameRate))
  const shape = (signal: Float32Array): Float32Array => {
    const smoothed = localMean(signal, radius)
    const out = new Float32Array(signal.length)
    let max = 0
    for (let i = 0; i < signal.length; i++) {
      const v = signal[i] - smoothed[i]
      const positive = v > 0 ? v : 0
      out[i] = positive
      if (positive > max) max = positive
    }
    if (max > 1e-9) {
      const inv = 1 / max
      for (let i = 0; i < out.length; i++) out[i] *= inv
    }
    return out
  }

  const shapedFlux = shape(flux)
  const shapedEnergy = shape(energyFlux)

  // Combine: flux dominates, energy flux adds weight on kick-heavy material.
  const combined = new Float32Array(frames)
  let maxCombined = 0
  for (let f = 0; f < frames; f++) {
    const v = 0.72 * shapedFlux[f] + 0.42 * shapedEnergy[f]
    combined[f] = v
    if (v > maxCombined) maxCombined = v
  }
  if (maxCombined > 1e-9) {
    const inv = 1 / maxCombined
    for (let f = 0; f < frames; f++) combined[f] *= inv
  }

  const normalizedBands = bandFlux.map((b) => shape(b))

  return {
    flux: combined,
    bandFlux: normalizedBands,
    rms: normalizeRms(rms),
    energyFlux: shapedEnergy,
    frames,
    frameRate: stft.frameRate,
  }
}

function localMean(signal: Float32Array, radius: number): Float32Array {
  const n = signal.length
  const out = new Float32Array(n)
  if (n === 0) return out
  let sum = 0
  let count = 0
  for (let i = 0; i <= Math.min(radius, n - 1); i++) {
    sum += signal[i]
    count++
  }
  for (let i = 0; i < n; i++) {
    out[i] = sum / count
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

function normalizeRms(rms: Float32Array): Float32Array {
  let max = 0
  for (let i = 0; i < rms.length; i++) if (rms[i] > max) max = rms[i]
  const out = new Float32Array(rms.length)
  if (max <= 1e-9) return out
  const inv = 1 / max
  for (let i = 0; i < rms.length; i++) out[i] = rms[i] * inv
  return out
}

export interface Peak {
  /** Index into the envelope. */
  index: number
  /** Interpolated sub-frame position. */
  position: number
  strength: number
}

/**
 * Adaptive peak picking on the onset envelope.
 *
 * A frame is an onset when it is a local maximum, exceeds `mean + delta` of a surrounding
 * window, and is at least `minGapSeconds` away from the previously accepted peak (in which
 * case the stronger peak wins).
 */
export function pickPeaks(
  envelope: Float32Array,
  frameRate: number,
  options: { delta?: number; windowSeconds?: number; minGapSeconds?: number; floor?: number } = {},
): Peak[] {
  const delta = options.delta ?? 0.06
  const windowSeconds = options.windowSeconds ?? 0.28
  const minGapSeconds = options.minGapSeconds ?? 0.055
  const floor = options.floor ?? 0.045
  const n = envelope.length
  const radius = Math.max(2, Math.round(windowSeconds * frameRate))
  const minGapFrames = Math.max(1, Math.round(minGapSeconds * frameRate))

  const smoothed = localMean(envelope, radius)
  const peaks: Peak[] = []
  for (let i = 1; i < n - 1; i++) {
    const v = envelope[i]
    if (v < floor) continue
    if (v < envelope[i - 1] || v < envelope[i + 1]) continue
    const threshold = smoothed[i] + delta
    if (v < threshold) continue
    // Parabolic interpolation for sub-frame accuracy.
    const a = envelope[i - 1]
    const b = v
    const c = envelope[i + 1]
    const denom = a - 2 * b + c
    const shift = Math.abs(denom) > 1e-12 ? (0.5 * (a - c)) / denom : 0
    const clampedShift = shift > 0.5 ? 0.5 : shift < -0.5 ? -0.5 : shift
    peaks.push({ index: i, position: i + clampedShift, strength: v })

    // Enforce the minimum gap by dropping the weaker of two nearby peaks.
    for (let j = peaks.length - 2; j >= 0; j--) {
      const other = peaks[j]
      if (peaks[peaks.length - 1].index - other.index >= minGapFrames) break
      if (other.strength >= b) {
        peaks.pop()
        break
      }
      peaks.splice(j, 1)
    }
  }
  return peaks
}

/**
 * Short-term energy envelope at a fine hop (default 1 ms blocks, smoothed over ~10 ms).
 * Cheap (O(n)) and accurate enough to locate real attacks, which is what onset refinement needs.
 */
export function computeEnergyEnvelope(
  samples: Float32Array,
  sampleRate: number,
  options: { blockMs?: number; smoothMs?: number } = {},
): { envelope: Float32Array; rate: number } {
  const blockMs = options.blockMs ?? 1
  const smoothMs = options.smoothMs ?? 10
  const block = Math.max(1, Math.round((blockMs / 1000) * sampleRate))
  const blocks = Math.max(1, Math.ceil(samples.length / block))
  const env = new Float32Array(blocks)
  for (let b = 0; b < blocks; b++) {
    const start = b * block
    const end = Math.min(samples.length, start + block)
    let acc = 0
    for (let i = start; i < end; i++) acc += samples[i] * samples[i]
    env[b] = end > start ? Math.sqrt(acc / (end - start)) : 0
  }
  const taps = Math.max(1, Math.round(smoothMs / blockMs))
  if (taps > 1) {
    const smoothed = new Float32Array(blocks)
    let sum = 0
    for (let b = 0; b < blocks; b++) {
      sum += env[b]
      if (b >= taps) sum -= env[b - taps]
      smoothed[b] = sum / Math.min(taps, b + 1)
    }
    return { envelope: smoothed, rate: sampleRate / block }
  }
  return { envelope: env, rate: sampleRate / block }
}

/**
 * Refine an onset time onto the actual energy attack.
 *
 * Spectral flux peaks land roughly half an analysis window (plus one hop) *before* the true
 * attack, because the flux is maximal while the transient is still rising through the window.
 * Left uncorrected that biases every generated note ~35 ms early — fatal for a rhythm game.
 *
 * Instead of a fixed correction we use the geometry of the analysis (`expectedDelay`, computed by
 * the caller from the frame size and hop) to centre a small search window and then pick the
 * steepest rise of the fine energy envelope inside it. The slope maximum is a robust attack
 * locator: it does not care about the previous note's decaying tail, and parabolic interpolation
 * gives sub-millisecond accuracy.
 */
export function refineOnsetTime(
  energyEnvelope: Float32Array,
  envelopeRate: number,
  approximateTime: number,
  expectedDelaySeconds: number,
  options: { searchBackSeconds?: number; searchForwardSeconds?: number } = {},
): number {
  const searchBack = options.searchBackSeconds ?? 0.028
  const searchForward = options.searchForwardSeconds ?? 0.032
  const center = approximateTime + expectedDelaySeconds
  const startIndex = Math.max(1, Math.round((center - searchBack) * envelopeRate))
  const endIndex = Math.min(energyEnvelope.length - 2, Math.round((center + searchForward) * envelopeRate))
  if (endIndex <= startIndex) return center

  let bestIndex = -1
  let bestSlope = 0
  for (let i = startIndex; i <= endIndex; i++) {
    const slope = energyEnvelope[i] - energyEnvelope[i - 1]
    if (slope > bestSlope) {
      bestSlope = slope
      bestIndex = i
    }
  }
  if (bestIndex < 0 || bestSlope <= 0) return center

  // Parabolic interpolation around the steepest sample for sub-block accuracy.
  const slopeBefore = energyEnvelope[bestIndex - 1] - (energyEnvelope[bestIndex - 2] ?? energyEnvelope[bestIndex - 1])
  const slopeAfter = energyEnvelope[bestIndex + 1] - energyEnvelope[bestIndex]
  const denom = slopeBefore - 2 * bestSlope + slopeAfter
  const shift = Math.abs(denom) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (slopeBefore - slopeAfter)) / denom)) : 0
  // Players hear a note when its attack begins, not at the middle of the rise: walk back from the
  // steepest point while the envelope is still clearly rising (up to 12 ms). On a sharp drum hit
  // this moves a millisecond or two; on a softer attack it removes a late bias of 10-20 ms.
  const maxBack = Math.round(0.012 * envelopeRate)
  let startIndex2 = bestIndex
  while (
    bestIndex - startIndex2 < maxBack &&
    startIndex2 - 1 > 0 &&
    energyEnvelope[startIndex2 - 1] - energyEnvelope[startIndex2 - 2] >= bestSlope * 0.35
  ) {
    startIndex2--
  }
  const refined = (startIndex2 === bestIndex ? bestIndex + shift : startIndex2) / envelopeRate
  // Never let refinement move an onset further than the analysis resolution.
  if (Math.abs(refined - center) > 0.06) return center
  return refined
}
