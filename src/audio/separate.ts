import { createFft } from './fftAny'

/**
 * Vocal separation around an MDX-Net model (Kim Vocal 2). The model takes a stereo spectrogram
 * block and returns the vocal part of it; this file does the spectrogram in and the audio out,
 * following the model's training setup (torch.stft, Hann window, centre padding).
 */
export const SEPARATOR = {
  rate: 44100,
  nFft: 7680,
  hop: 1024,
  /** Frequency bins the model sees; higher bins are dropped. */
  bins: 3072,
  /** Frames per model run. */
  block: 256,
  /** Frames of context on each side of a block that are run but not kept. */
  margin: 32,
  /** Gain the model's authors apply to its output. */
  compensate: 1.009,
} as const

/** One model run: a [1, 4, bins, block] spectrogram (left re, left im, right re, right im) in, vocals out. */
export type RunBlock = (input: Float32Array) => Promise<Float32Array>

const blockSize = SEPARATOR.bins * SEPARATOR.block

function hann(size: number): Float64Array {
  const w = new Float64Array(size)
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  return w
}

/** Reflect-padded sample, the way torch.stft pads with center=True. */
function reflected(signal: Float32Array, index: number): number {
  const n = signal.length
  if (n === 1) return signal[0]
  let i = index
  while (i < 0 || i >= n) i = i < 0 ? -i : 2 * (n - 1) - i
  return signal[i]
}

/**
 * The vocals of a stereo song, as one mono track at SEPARATOR.rate. `left` and `right` must
 * already be at that rate.
 */
export async function separateVocals(
  left: Float32Array,
  right: Float32Array,
  run: RunBlock,
  onProgress?: (fraction: number) => void,
): Promise<Float32Array> {
  const { nFft, hop, bins, block, margin, compensate } = SEPARATOR
  const length = Math.min(left.length, right.length)
  const frames = 1 + Math.floor(length / hop)
  const half = nFft / 2
  const window = hann(nFft)
  const fft = createFft(nFft)
  const re = new Float64Array(nFft)
  const im = new Float64Array(nFft)
  const out = new Float64Array(length)
  const envelope = new Float64Array(length)
  const keepPerBlock = block - 2 * margin
  const total = Math.ceil(frames / keepPerBlock)
  const input = new Float32Array(4 * blockSize)

  // Overlap-add one real frame (in re) centred on frame index `frame`.
  const addFrame = (frame: number, values: Float64Array): void => {
    const start = frame * hop - half
    for (let i = 0; i < nFft; i++) {
      const at = start + i
      if (at < 0 || at >= length) continue
      out[at] += values[i] * window[i]
      envelope[at] += window[i] * window[i]
    }
  }

  for (let b = 0; b < total; b++) {
    const first = b * keepPerBlock - margin
    input.fill(0)
    for (let t = 0; t < block; t++) {
      const frame = first + t
      if (frame < 0 || frame >= frames) continue
      // Left and right in one complex transform: z = l + i r.
      const start = frame * hop - half
      for (let i = 0; i < nFft; i++) {
        re[i] = reflected(left, start + i) * window[i]
        im[i] = reflected(right, start + i) * window[i]
      }
      fft.forward(re, im)
      for (let f = 3; f < bins; f++) {
        const g = nFft - f
        const lr = (re[f] + re[g]) / 2
        const li = (im[f] - im[g]) / 2
        const rr = (im[f] + im[g]) / 2
        const ri = (re[g] - re[f]) / 2
        input[(0 * bins + f) * block + t] = lr
        input[(1 * bins + f) * block + t] = li
        input[(2 * bins + f) * block + t] = rr
        input[(3 * bins + f) * block + t] = ri
      }
    }

    const vocals = await run(input)

    // Mono spectrum of each kept frame, two frames per inverse transform (a + i b).
    const kept: number[] = []
    for (let t = margin; t < margin + keepPerBlock; t++) {
      const frame = first + t
      if (frame >= 0 && frame < frames) kept.push(t)
    }
    for (let k = 0; k < kept.length; k += 2) {
      const ta = kept[k]
      const tb = k + 1 < kept.length ? kept[k + 1] : -1
      re.fill(0)
      im.fill(0)
      for (let f = 0; f < bins; f++) {
        const ar = (vocals[(0 * bins + f) * block + ta] + vocals[(2 * bins + f) * block + ta]) / 2
        // The DC bin of a real signal has no imaginary part.
        const ai = f === 0 ? 0 : (vocals[(1 * bins + f) * block + ta] + vocals[(3 * bins + f) * block + ta]) / 2
        let br = 0
        let bi = 0
        if (tb >= 0) {
          br = (vocals[(0 * bins + f) * block + tb] + vocals[(2 * bins + f) * block + tb]) / 2
          bi = f === 0 ? 0 : (vocals[(1 * bins + f) * block + tb] + vocals[(3 * bins + f) * block + tb]) / 2
        }
        // Z = A + i B, with A and B Hermitian so the inverse gives a + i b.
        re[f] += ar - bi
        im[f] += ai + br
        if (f > 0) {
          const g = nFft - f
          re[g] += ar + bi
          im[g] += -ai + br
        }
      }
      fft.inverse(re, im)
      addFrame(first + ta, re)
      if (tb >= 0) addFrame(first + tb, im)
    }
    onProgress?.((b + 1) / total)
  }

  const mono = new Float32Array(length)
  for (let i = 0; i < length; i++) mono[i] = envelope[i] > 1e-8 ? (out[i] / envelope[i]) * compensate : 0
  return mono
}
