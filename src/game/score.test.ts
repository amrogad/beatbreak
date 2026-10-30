import { describe, expect, it } from 'vitest'
import {
  BASE_NOTE_SCORE,
  COMBO_BONUS_CAP,
  accuracyFromTally,
  applyJudgment,
  comboMultiplier,
  comboRecognition,
  createScoreState,
  emptyTally,
  finalAccuracy,
  gradeFor,
  maxScore,
  noteScore,
  npsOf,
  registerHoldDrop,
} from './score'

describe('combo multiplier', () => {
  it('starts at 1× and caps at +50%', () => {
    expect(comboMultiplier(0)).toBeCloseTo(1, 12)
    expect(comboMultiplier(150)).toBeCloseTo(1.5, 12)
    expect(comboMultiplier(COMBO_BONUS_CAP * 10)).toBeCloseTo(1.5, 12)
  })
})

describe('note scoring', () => {
  it('scales the base score by the judgment weight', () => {
    expect(noteScore('marvelous', 0)).toBe(BASE_NOTE_SCORE)
    expect(noteScore('perfect', 0)).toBe(90)
    expect(noteScore('great', 0)).toBe(72)
    expect(noteScore('good', 0)).toBe(45)
    expect(noteScore('miss', 0)).toBe(0)
  })

  it('adds the combo bonus before the judgment weight', () => {
    expect(noteScore('marvelous', 1)).toBe(100) // round(100 × 301/300)
    expect(noteScore('marvelous', 150)).toBe(150)
    expect(noteScore('miss', 150)).toBe(0)
  })
})

describe('applyJudgment', () => {
  it('does not mutate the state it receives', () => {
    const before = createScoreState(10)
    const snapshot = JSON.stringify(before)
    const after = applyJudgment(before, 'marvelous')
    expect(JSON.stringify(before)).toBe(snapshot)
    expect(after).not.toBe(before)
  })

  it('builds combo, score and tally', () => {
    let state = createScoreState(5)
    state = applyJudgment(state, 'marvelous')
    state = applyJudgment(state, 'marvelous')
    expect(state.combo).toBe(2)
    expect(state.bestCombo).toBe(2)
    expect(state.score).toBe(200)
    state = applyJudgment(state, 'good')
    expect(state.combo).toBe(3) // Good keeps the combo alive
    expect(state.tally).toEqual({ marvelous: 2, perfect: 0, great: 0, good: 1, miss: 0 })
  })

  it('keeps the combo for low hit tiers and breaks it only on Miss', () => {
    let state = createScoreState(5)
    state = applyJudgment(state, 'marvelous')
    state = applyJudgment(state, 'marvelous')
    const before = state.score
    state = applyJudgment(state, 'good')
    expect(state.combo).toBe(3)
    expect(state.score - before).toBeGreaterThanOrEqual(45) // 45 base × the combo it rode
    state = applyJudgment(state, 'miss')
    expect(state.combo).toBe(0)
    expect(state.tally.good).toBe(1)
    expect(state.tally.miss).toBe(1)
  })
})

describe('accuracy', () => {
  it('reads 100% before the first judgment and during a perfect run', () => {
    expect(createScoreState(4).accuracy).toBe(1)
    let state = createScoreState(4)
    state = applyJudgment(state, 'marvelous')
    state = applyJudgment(state, 'marvelous')
    expect(state.accuracy).toBeCloseTo(1, 12)
  })

  it('weights every judgment and reports a live value', () => {
    expect(accuracyFromTally({ marvelous: 1, perfect: 1, great: 1, good: 1, miss: 1 }, 5)).toBeCloseTo(
      (1 + 0.9 + 0.72 + 0.45 + 0) / 5,
      12,
    )
    expect(accuracyFromTally(emptyTally(), 0)).toBe(1)
  })

  it('counts unplayed notes as misses in the final accuracy', () => {
    expect(finalAccuracy({ marvelous: 3, perfect: 0, great: 0, good: 0, miss: 0 }, 12)).toBeCloseTo(0.25, 12)
    expect(finalAccuracy({ marvelous: 0, perfect: 0, great: 0, good: 0, miss: 12 }, 12)).toBe(0)
    expect(finalAccuracy({ marvelous: 12, perfect: 0, great: 0, good: 0, miss: 0 }, 12)).toBe(1)
  })
})

describe('grades', () => {
  it('maps accuracy to letter grades at the documented thresholds', () => {
    expect(gradeFor(1).label).toBe('SSS')
    expect(gradeFor(0.995).label).toBe('SSS')
    expect(gradeFor(0.994).label).toBe('SS')
    expect(gradeFor(0.98).label).toBe('SS')
    expect(gradeFor(0.9799).label).toBe('S')
    expect(gradeFor(0.95).label).toBe('S')
    expect(gradeFor(0.9499).label).toBe('A')
    expect(gradeFor(0.9).label).toBe('A')
    expect(gradeFor(0.8999).label).toBe('B')
    expect(gradeFor(0.8).label).toBe('B')
    expect(gradeFor(0.7999).label).toBe('C')
    expect(gradeFor(0.7).label).toBe('C')
    expect(gradeFor(0.6999).label).toBe('D')
    expect(gradeFor(0.6).label).toBe('D')
    expect(gradeFor(0.5999).label).toBe('F')
    expect(gradeFor(0).label).toBe('F')
  })

  it('forces an F for a failed run regardless of accuracy', () => {
    expect(gradeFor(1, true).label).toBe('F')
  })
})

describe('maxScore', () => {
  it('sums what a perfect run would earn, including combo growth', () => {
    expect(maxScore(0)).toBe(0)
    expect(maxScore(1)).toBe(100)
    expect(maxScore(2)).toBe(200)
    // With the capped combo bonus the total can never exceed 1.5× base per note.
    expect(maxScore(500)).toBeLessThanOrEqual(500 * 150)
    expect(maxScore(500)).toBeGreaterThan(500 * 100)
    let previous = 0
    for (let i = 1; i <= 40; i++) {
      const value = maxScore(i)
      expect(value).toBeGreaterThan(previous)
      previous = value
    }
  })
})

describe('npsOf', () => {
  it('computes notes per second and guards against zero duration', () => {
    expect(npsOf(120, 60)).toBe(2)
    expect(npsOf(10, 0)).toBe(0)
    expect(npsOf(0, 10)).toBe(0)
  })
})

describe('dropped holds', () => {
  it('break the combo without consuming a note and join the accuracy denominator', () => {
    let state = createScoreState(4)
    state = applyJudgment(state, 'marvelous')
    state = applyJudgment(state, 'marvelous')
    expect(state.accuracy).toBeCloseTo(1, 9)
    const dropped = registerHoldDrop(state)
    expect(dropped.combo).toBe(0)
    expect(dropped.judged).toBe(2) // drops are not note judgements
    expect(dropped.droppedHolds).toBe(1)
    expect(dropped.accuracy).toBeCloseTo(2 / 3, 9) // weights 1 + 1 over 3 attempts
    expect(dropped.score).toBe(state.score) // no points are subtracted, only lost
  })

  it('stay in the denominator when the next note is judged', () => {
    let state = createScoreState(4)
    state = applyJudgment(state, 'marvelous')
    state = registerHoldDrop(state)
    state = applyJudgment(state, 'marvelous')
    expect(state.accuracy).toBeCloseTo(2 / 3, 9)
  })

  it('lower the final accuracy used by the results screen', () => {
    const tally = { ...emptyTally(), marvelous: 4 }
    expect(finalAccuracy(tally, 4)).toBeCloseTo(1, 9)
    // The head of the dropped hold was a Marvelous, so the completed notes still weigh 4 out of
    // 4 notes plus 1 drop.
    expect(finalAccuracy(tally, 4, 1)).toBeCloseTo(4 / 5, 9)
  })
})

describe('combo recognition', () => {
  const base = { autoPlay: false, failed: false, totalNotes: 10 }

  it('recognises a clean run, and distinguishes the all-marvelous one', () => {
    expect(comboRecognition({ ...base, tally: { ...emptyTally(), marvelous: 8, perfect: 2 } })).toBe('full-combo')
    expect(comboRecognition({ ...base, tally: { ...emptyTally(), marvelous: 10 } })).toBe('marvelous-full-combo')
  })

  it('refuses runs with a miss or a dropped hold', () => {
    expect(comboRecognition({ ...base, tally: { ...emptyTally(), marvelous: 9, miss: 1 } })).toBeNull()
    expect(
      comboRecognition({ ...base, tally: { ...emptyTally(), marvelous: 10 }, droppedHolds: 1 }),
    ).toBeNull()
  })

  it('refuses runs that did not judge every note, failed runs and auto-play runs', () => {
    // A forfeited run (stopped in the middle) has judged fewer notes than the chart holds.
    expect(comboRecognition({ ...base, tally: { ...emptyTally(), marvelous: 6 } })).toBeNull()
    expect(comboRecognition({ ...base, failed: true, tally: { ...emptyTally(), marvelous: 10 } })).toBeNull()
    expect(comboRecognition({ ...base, autoPlay: true, tally: { ...emptyTally(), marvelous: 10 } })).toBeNull()
  })
})
