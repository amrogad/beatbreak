import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOWS,
  TOUCH_WINDOW_SCALE,
  JUDGMENT_LABEL,
  JUDGMENT_WEIGHT,
  WINDOW_PRESETS,
  compensateInputLatency,
  isMissed,
  isWithinHitWindow,
  judge,
  normalizeCustomWindows,
  timingLabel,
  windowsForDifficulty,
} from './judgment'
import { JUDGMENTS } from '../core/types'

describe('judge: window boundaries', () => {
  const w = DEFAULT_WINDOWS

  it('classifies deltas inside each window', () => {
    expect(judge(0, w)).toBe('marvelous')
    expect(judge(10, w)).toBe('marvelous')
    expect(judge(-10, w)).toBe('marvelous')
    expect(judge(30, w)).toBe('perfect')
    expect(judge(33, w)).toBe('perfect')
    expect(judge(-33, w)).toBe('perfect')
    expect(judge(55, w)).toBe('great')
    expect(judge(60, w)).toBe('great')
    expect(judge(70, w)).toBe('good')
    expect(judge(80, w)).toBe('good')
    expect(judge(-80, w)).toBe('good')
    expect(judge(90, w)).toBe('miss')
    expect(judge(500, w)).toBe('miss')
  })

  it('counts a delta exactly on an edge as the tighter tier (<=, not <)', () => {
    expect(judge(w.marvelous, w)).toBe('marvelous')
    expect(judge(w.marvelous + 0.001, w)).toBe('perfect')
    expect(judge(-w.marvelous, w)).toBe('marvelous')
    expect(judge(w.perfect, w)).toBe('perfect')
    expect(judge(w.perfect + 0.001, w)).toBe('great')
    expect(judge(w.great, w)).toBe('great')
    expect(judge(w.great + 0.001, w)).toBe('good')
    expect(judge(w.good, w)).toBe('good')
    expect(judge(w.good + 0.001, w)).toBe('miss')
  })
})

describe('hit and miss windows', () => {
  it('consumes taps only inside ±good', () => {
    expect(isWithinHitWindow(DEFAULT_WINDOWS.good, DEFAULT_WINDOWS)).toBe(true)
    expect(isWithinHitWindow(-DEFAULT_WINDOWS.good, DEFAULT_WINDOWS)).toBe(true)
    expect(isWithinHitWindow(DEFAULT_WINDOWS.good + 0.001, DEFAULT_WINDOWS)).toBe(false)
  })

  it('misses a note only strictly past missAfter', () => {
    expect(isMissed(DEFAULT_WINDOWS.missAfter, DEFAULT_WINDOWS)).toBe(false)
    expect(isMissed(DEFAULT_WINDOWS.missAfter + 0.001, DEFAULT_WINDOWS)).toBe(true)
    expect(isMissed(-50, DEFAULT_WINDOWS)).toBe(false) // the note is still in the future
  })

  it('keeps the windows strictly ordered inside every preset', () => {
    for (const preset of Object.values(WINDOW_PRESETS)) {
      expect(preset.marvelous).toBeLessThan(preset.perfect)
      expect(preset.perfect).toBeLessThan(preset.great)
      expect(preset.great).toBeLessThan(preset.good)
      expect(preset.missAfter).toBeGreaterThanOrEqual(preset.good)
    }
  })
})

describe('window presets and difficulty scaling', () => {
  const tiers = ['marvelous', 'perfect', 'great', 'good', 'missAfter'] as const

  it('orders presets from strict to lenient', () => {
    for (const tier of tiers) {
      expect(WINDOW_PRESETS.strict[tier]).toBeLessThan(WINDOW_PRESETS.standard[tier])
      expect(WINDOW_PRESETS.standard[tier]).toBeLessThan(WINDOW_PRESETS.lenient[tier])
    }
  })

  it('keeps windows tight on every difficulty, tighter still on expert', () => {
    const easy = windowsForDifficulty('standard', 'easy')
    const normal = windowsForDifficulty('standard', 'normal')
    const hard = windowsForDifficulty('standard', 'hard')
    const expert = windowsForDifficulty('standard', 'expert')
    for (const tier of tiers) {
      expect(easy[tier]).toBeGreaterThanOrEqual(normal[tier])
      expect(normal[tier]).toBeGreaterThanOrEqual(hard[tier])
      expect(hard[tier]).toBeGreaterThanOrEqual(expert[tier])
    }
    expect(hard).toEqual(DEFAULT_WINDOWS) // standard preset is the reference point
    expect(expert).toEqual({ marvelous: 14, perfect: 30, great: 55, good: 74, missAfter: 74 })
    expect(easy).toEqual(DEFAULT_WINDOWS)
  })

  it('ships StepMania’s own windows (W1–W4) as a preset', () => {
    // Values straight from StepMania's Player.cpp (`TimingWindowSecondsInit`, dance mode).
    expect(WINDOW_PRESETS.stepmania).toEqual({ marvelous: 22.5, perfect: 45, great: 90, good: 135, missAfter: 135 })
    expect(windowsForDifficulty('stepmania', 'hard')).toEqual(WINDOW_PRESETS.stepmania)
  })
})

describe('custom windows', () => {
  it('uses hand-set windows exactly, at every difficulty', () => {
    const custom = { marvelous: 12, perfect: 30, great: 60, good: 100 }
    expect(windowsForDifficulty('custom', 'expert', custom)).toEqual({ ...custom, missAfter: 100 })
    expect(windowsForDifficulty('custom', 'easy', custom)).toEqual({ ...custom, missAfter: 100 })
  })

  it('orders and clamps hand-set windows', () => {
    expect(normalizeCustomWindows({ marvelous: 50, perfect: 10, great: 5, good: 2 })).toEqual({
      marvelous: 50,
      perfect: 50,
      great: 50,
      good: 50,
    })
    expect(normalizeCustomWindows(undefined)).toEqual({
      marvelous: DEFAULT_WINDOWS.marvelous,
      perfect: DEFAULT_WINDOWS.perfect,
      great: DEFAULT_WINDOWS.great,
      good: DEFAULT_WINDOWS.good,
    })
  })
})

describe('judgment metadata', () => {
  it('weights hits from marvelous to miss in descending order', () => {
    expect(JUDGMENT_WEIGHT.marvelous).toBe(1)
    expect(JUDGMENT_WEIGHT.miss).toBe(0)
    const values = JUDGMENTS.map((j) => JUDGMENT_WEIGHT[j])
    expect(values).toEqual([...values].sort((a, b) => b - a))
    for (const judgment of JUDGMENTS) expect(JUDGMENT_LABEL[judgment].length).toBeGreaterThan(0)
  })
})

describe('compensateInputLatency', () => {
  it('pulls the tap back by the event lag', () => {
    // The event happened 15 ms before we read the audio clock at song time 5 s.
    expect(compensateInputLatency(1000, 5000, 1015)).toBeCloseTo(4985, 9)
  })

  it('clamps implausible lag and never moves the tap forward', () => {
    // 200 ms of lag means a stalled main thread: trust the audio clock instead.
    expect(compensateInputLatency(1000, 5000, 1200)).toBeCloseTo(4975, 9)
    // A timestamp "in the future" (clock skew) must not push the tap forward.
    expect(compensateInputLatency(1100, 5000, 1000)).toBeCloseTo(5000, 9)
  })

  it('subtracts the calibrated latency as well', () => {
    expect(compensateInputLatency(1000, 5000, 1005, 12)).toBeCloseTo(4983, 9)
  })

  it('labels early/late feedback', () => {
    expect(timingLabel(0.4)).toBe('on time')
    expect(timingLabel(-6)).toBe('early')
    expect(timingLabel(6)).toBe('late')
  })
})

describe('touch windows', () => {
  it('widens every window by the touch scale on touch screens', () => {
    const keys = windowsForDifficulty('standard', 'normal')
    const touch = windowsForDifficulty('standard', 'normal', undefined, true)
    expect(touch.good).toBe(Math.round(keys.good * TOUCH_WINDOW_SCALE))
    expect(touch.marvelous).toBe(Math.round(keys.marvelous * TOUCH_WINDOW_SCALE))
    expect(touch.missAfter).toBe(touch.good)
  })
})
