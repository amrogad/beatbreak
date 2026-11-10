/**
 * Complex FFT for lengths built from small primes (2, 3, 5, ...), not only powers of two. The vocal
 * separator works on 7680-sample frames (2^9 x 3 x 5).
 *
 * Self-sorting Stockham passes, one per factor, between two buffers; radix 2 and 4 have their own
 * butterflies, other factors use a small DFT.
 */
export interface Fft {
  readonly size: number
  /** Forward transform in place (no scaling). */
  forward(re: Float64Array, im: Float64Array): void
  /** Inverse transform in place, scaled by 1/size. */
  inverse(re: Float64Array, im: Float64Array): void
}

interface Stage {
  radix: number
  /** Length of the sub-sequence this pass splits. */
  n: number
  /** Stride of the pass. */
  stride: number
  /** Twiddle cos/sin for output t of group p, at [p * radix + t]. */
  twRe: Float64Array
  twIm: Float64Array
}

function factorize(n: number): number[] {
  const factors: number[] = []
  let rest = n
  while (rest % 4 === 0) {
    factors.push(4)
    rest /= 4
  }
  for (let p = 2; rest > 1; p++) {
    while (rest % p === 0) {
      factors.push(p)
      rest /= p
    }
  }
  return factors
}

export function createFft(size: number): Fft {
  if (!Number.isInteger(size) || size < 1) throw new Error('fft: size must be a positive integer')
  const stages: Stage[] = []
  let n = size
  let stride = 1
  for (const radix of factorize(size)) {
    const m = n / radix
    const twRe = new Float64Array(m * radix)
    const twIm = new Float64Array(m * radix)
    for (let p = 0; p < m; p++) {
      for (let t = 0; t < radix; t++) {
        const angle = (-2 * Math.PI * p * t) / n
        twRe[p * radix + t] = Math.cos(angle)
        twIm[p * radix + t] = Math.sin(angle)
      }
    }
    stages.push({ radix, n, stride, twRe, twIm })
    n = m
    stride *= radix
  }
  const maxRadix = Math.max(1, ...stages.map((s) => s.radix))
  const dftRe = new Float64Array(maxRadix * maxRadix)
  const dftIm = new Float64Array(maxRadix * maxRadix)
  const bufRe = new Float64Array(size)
  const bufIm = new Float64Array(size)
  const aRe = new Float64Array(maxRadix)
  const aIm = new Float64Array(maxRadix)

  const run = (re: Float64Array, im: Float64Array): void => {
    if (re.length !== size || im.length !== size) throw new Error(`fft: expected ${size} values`)
    let xRe = re
    let xIm = im
    let yRe = bufRe
    let yIm = bufIm
    for (const stage of stages) {
      const { radix, n: len, stride: s, twRe, twIm } = stage
      const m = len / radix
      if (radix === 2) {
        for (let p = 0; p < m; p++) {
          const wr = twRe[p * 2 + 1]
          const wi = twIm[p * 2 + 1]
          for (let q = 0; q < s; q++) {
            const i0 = q + s * p
            const i1 = i0 + s * m
            const ar = xRe[i0]
            const ai = xIm[i0]
            const br = xRe[i1]
            const bi = xIm[i1]
            const o = q + s * 2 * p
            yRe[o] = ar + br
            yIm[o] = ai + bi
            const dr = ar - br
            const di = ai - bi
            yRe[o + s] = dr * wr - di * wi
            yIm[o + s] = dr * wi + di * wr
          }
        }
      } else if (radix === 4) {
        for (let p = 0; p < m; p++) {
          const base = p * 4
          const w1r = twRe[base + 1]
          const w1i = twIm[base + 1]
          const w2r = twRe[base + 2]
          const w2i = twIm[base + 2]
          const w3r = twRe[base + 3]
          const w3i = twIm[base + 3]
          for (let q = 0; q < s; q++) {
            const i0 = q + s * p
            const i1 = i0 + s * m
            const i2 = i1 + s * m
            const i3 = i2 + s * m
            const t0r = xRe[i0] + xRe[i2]
            const t0i = xIm[i0] + xIm[i2]
            const t1r = xRe[i0] - xRe[i2]
            const t1i = xIm[i0] - xIm[i2]
            const t2r = xRe[i1] + xRe[i3]
            const t2i = xIm[i1] + xIm[i3]
            // (x1 - x3) * -i
            const t3r = xIm[i1] - xIm[i3]
            const t3i = xRe[i3] - xRe[i1]
            const o = q + s * 4 * p
            yRe[o] = t0r + t2r
            yIm[o] = t0i + t2i
            const y1r = t1r + t3r
            const y1i = t1i + t3i
            const y2r = t0r - t2r
            const y2i = t0i - t2i
            const y3r = t1r - t3r
            const y3i = t1i - t3i
            yRe[o + s] = y1r * w1r - y1i * w1i
            yIm[o + s] = y1r * w1i + y1i * w1r
            yRe[o + 2 * s] = y2r * w2r - y2i * w2i
            yIm[o + 2 * s] = y2r * w2i + y2i * w2r
            yRe[o + 3 * s] = y3r * w3r - y3i * w3i
            yIm[o + 3 * s] = y3r * w3i + y3i * w3r
          }
        }
      } else {
        for (let t = 0; t < radix; t++) {
          for (let j = 0; j < radix; j++) {
            const angle = (-2 * Math.PI * ((j * t) % radix)) / radix
            dftRe[t * radix + j] = Math.cos(angle)
            dftIm[t * radix + j] = Math.sin(angle)
          }
        }
        for (let p = 0; p < m; p++) {
          for (let q = 0; q < s; q++) {
            for (let j = 0; j < radix; j++) {
              aRe[j] = xRe[q + s * (p + j * m)]
              aIm[j] = xIm[q + s * (p + j * m)]
            }
            const o = q + s * radix * p
            for (let t = 0; t < radix; t++) {
              let sr = 0
              let si = 0
              for (let j = 0; j < radix; j++) {
                const cr = dftRe[t * radix + j]
                const ci = dftIm[t * radix + j]
                sr += aRe[j] * cr - aIm[j] * ci
                si += aRe[j] * ci + aIm[j] * cr
              }
              const wr = twRe[p * radix + t]
              const wi = twIm[p * radix + t]
              yRe[o + s * t] = sr * wr - si * wi
              yIm[o + s * t] = sr * wi + si * wr
            }
          }
        }
      }
      const swapRe = xRe
      const swapIm = xIm
      xRe = yRe
      xIm = yIm
      yRe = swapRe
      yIm = swapIm
    }
    if (xRe !== re) {
      re.set(xRe)
      im.set(xIm)
    }
  }

  return {
    size,
    forward: run,
    inverse(re, im) {
      for (let i = 0; i < size; i++) im[i] = -im[i]
      run(re, im)
      const scale = 1 / size
      for (let i = 0; i < size; i++) {
        re[i] *= scale
        im[i] = -im[i] * scale
      }
    },
  }
}
