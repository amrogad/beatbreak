import { describe, expect, it } from 'vitest'
import { calibrate } from './calibration'
import { arrowOffsetMs } from '../store/settings'

describe('tap-along calibration', () => {
  it('turns a steady tap delay into the setting that makes those taps land on time', () => {
    // Bluetooth the browser does not report: taps land 210 ms behind the click, reported latency 10 ms.
    const taps = [400, -300, 90, 250, ...Array.from({ length: 16 }, (_, i) => 210 + ((i % 5) - 2) * 6)]
    const result = calibrate(taps, 10)!
    expect(result.delayMs).toBe(210)
    // The engine judges a press at graph + delay as graph + delay - latency - offset: that must be 0 late.
    const offset = arrowOffsetMs(result.audioOffsetMs)
    expect(210 - 10 - offset).toBeCloseTo(0, 0)
  })

  it('ignores the warm-up taps and slips, and needs enough taps', () => {
    expect(calibrate([0, 0, 0, 0, 30, 30, 30], 0)).toBeNull()
    const result = calibrate([900, 900, 900, 900, ...Array(10).fill(40), 800], 0)!
    expect(result.delayMs).toBe(40)
  })
})
