import { describe, expect, it } from 'vitest'
import { createFft } from './fftAny'

function naive(re: Float64Array, im: Float64Array): [Float64Array, Float64Array] {
  const n = re.length
  const outRe = new Float64Array(n)
  const outIm = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    for (let j = 0; j < n; j++) {
      const angle = (-2 * Math.PI * ((j * k) % n)) / n
      outRe[k] += re[j] * Math.cos(angle) - im[j] * Math.sin(angle)
      outIm[k] += re[j] * Math.sin(angle) + im[j] * Math.cos(angle)
    }
  }
  return [outRe, outIm]
}

const random = (n: number, seed: number): Float64Array => {
  let s = seed
  return new Float64Array(n).map(() => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648 - 0.5
  })
}

describe('mixed-radix fft', () => {
  for (const n of [1, 2, 3, 4, 5, 6, 8, 12, 15, 16, 30, 60, 120, 7680 / 8]) {
    it(`matches a plain DFT at ${n}`, () => {
      const re = random(n, n)
      const im = random(n, n + 7)
      const [wantRe, wantIm] = naive(re, im)
      createFft(n).forward(re, im)
      for (let k = 0; k < n; k++) {
        expect(re[k]).toBeCloseTo(wantRe[k], 8)
        expect(im[k]).toBeCloseTo(wantIm[k], 8)
      }
    })
  }

  it('round-trips the separator frame size', () => {
    const n = 7680
    const re = random(n, 3)
    const im = random(n, 4)
    const copyRe = re.slice()
    const copyIm = im.slice()
    const fft = createFft(n)
    fft.forward(re, im)
    fft.inverse(re, im)
    for (let k = 0; k < n; k += 37) {
      expect(re[k]).toBeCloseTo(copyRe[k], 10)
      expect(im[k]).toBeCloseTo(copyIm[k], 10)
    }
  })

  it('puts a pure tone in its bin', () => {
    const n = 7680
    const re = new Float64Array(n).map((_, i) => Math.cos((2 * Math.PI * 100 * i) / n))
    const im = new Float64Array(n)
    createFft(n).forward(re, im)
    expect(re[100]).toBeCloseTo(n / 2, 6)
    expect(re[n - 100]).toBeCloseTo(n / 2, 6)
    expect(Math.abs(re[101])).toBeLessThan(1e-6)
  })
})
