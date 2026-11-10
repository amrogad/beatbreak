import { describe, expect, it } from 'vitest'
import { SEPARATOR, separateVocals } from './separate'

const tone = (seconds: number, hz: number, gain: number): Float32Array =>
  new Float32Array(Math.round(seconds * SEPARATOR.rate)).map((_, i) => gain * Math.sin((2 * Math.PI * hz * i) / SEPARATOR.rate))

describe('vocal separation frame', () => {
  it('gives back the mix when the model passes everything through', async () => {
    const left = tone(9, 440, 0.5)
    const right = tone(9, 660, 0.3)
    let runs = 0
    const progress: number[] = []
    const vocals = await separateVocals(left, right, async (input) => {
      runs++
      return input.slice()
    }, (f) => progress.push(f))
    expect(runs).toBe(Math.ceil((1 + Math.floor(left.length / SEPARATOR.hop)) / (SEPARATOR.block - 2 * SEPARATOR.margin)))
    expect(progress[progress.length - 1]).toBe(1)
    let worst = 0
    for (let i = SEPARATOR.nFft; i < left.length - SEPARATOR.nFft; i++) {
      worst = Math.max(worst, Math.abs(vocals[i] - SEPARATOR.compensate * (left[i] + right[i]) / 2))
    }
    expect(worst).toBeLessThan(1e-3)
  })

  it('is silent when the model hears no vocals', async () => {
    const left = tone(3, 440, 0.5)
    const vocals = await separateVocals(left, left, async (input) => new Float32Array(input.length))
    expect(vocals.every((v) => v === 0)).toBe(true)
  })
})
