/**
 * Scoring.
 *
 * Design goals: readable numbers, no hidden state, and one place where accuracy and grades are
 * defined so the results screen, the HUD and the tests all agree.
 *
 *   note score  = round(BASE * judgmentWeight * comboMultiplier)
 *   comboMultiplier = 1 + min(combo, 150) / 300   (so a long combo can add up to +50%)
 *   accuracy    = Σ judgmentWeight / notes judged
 */
import type { Judgment, JudgmentTally, ScoreState } from '../core/types'
import { JUDGMENT_WEIGHT } from './judgment'

/**
 * 100 points per arrow keeps a four-minute chart in the tens of thousands instead of the
 * hundreds of thousands, while still leaving room for the combo bonus to matter.
 */
export const BASE_NOTE_SCORE = 100
export const COMBO_BONUS_CAP = 150
export const COMBO_BONUS_SCALE = 300

export const emptyTally = (): JudgmentTally => ({ marvelous: 0, perfect: 0, great: 0, good: 0, miss: 0 })

export function createScoreState(totalNotes: number): ScoreState {
  return {
    score: 0,
    combo: 0,
    bestCombo: 0,
    accuracy: 1,
    judged: 0,
    tally: emptyTally(),
    totalNotes,
    droppedHolds: 0,
  }
}

export function comboMultiplier(combo: number): number {
  return 1 + Math.min(combo, COMBO_BONUS_CAP) / COMBO_BONUS_SCALE
}

/** Points a note is worth at the given combo (before the judgment is applied). */
export function noteScore(judgment: Judgment, combo: number): number {
  return Math.round(BASE_NOTE_SCORE * JUDGMENT_WEIGHT[judgment] * comboMultiplier(combo))
}

/**
 * Apply a judgment. Returns a new state (safe for React state updates) — the input is untouched.
 * Only a Miss breaks the combo (arcade rule: every hit tier keeps it alive).
 */
export function applyJudgment(state: ScoreState, judgment: Judgment): ScoreState {
  const tally: JudgmentTally = { ...state.tally, [judgment]: state.tally[judgment] + 1 }
  const breaksCombo = judgment === 'miss'
  const combo = breaksCombo ? 0 : state.combo + 1
  const gained = noteScore(judgment, state.combo)
  const judged = state.judged + 1
  return {
    score: state.score + gained,
    combo,
    bestCombo: Math.max(state.bestCombo, combo),
    accuracy: accuracyFromTally(tally, judged + state.droppedHolds),
    judged,
    tally,
    totalNotes: state.totalNotes,
    droppedHolds: state.droppedHolds,
  }
}

/**
 * A held note was released early: the combo breaks and the dropped hold joins the accuracy
 * denominator as a zero — the note's earlier head judgment keeps its weight, so dropping a hold
 * costs roughly half of that note's value on top of the combo. Counted by every fail rule that
 * counts misses.
 */
export function registerHoldDrop(state: ScoreState): ScoreState {
  const droppedHolds = state.droppedHolds + 1
  return {
    ...state,
    combo: 0,
    accuracy: accuracyFromTally(state.tally, state.judged + droppedHolds),
    droppedHolds,
  }
}

/**
 * Accuracy over the attempts made so far (what the HUD shows while playing). `attempts` is the
 * number of judged notes plus any dropped holds.
 */
export function accuracyFromTally(tally: JudgmentTally, attempts: number): number {
  // Before any judgement the HUD shows 100%, not 0%; the final accuracy is recomputed by
  // `finalAccuracy` so quitting early can never inflate the result screen.
  if (attempts <= 0) return 1
  return clamp01(weightedTally(tally) / attempts)
}

/** Final accuracy used by the results screen: unplayed notes and dropped holds count as zeroes. */
export function finalAccuracy(tally: JudgmentTally, totalNotes: number, droppedHolds = 0): number {
  const judgedNotes = tally.marvelous + tally.perfect + tally.great + tally.good + tally.miss
  const missed = Math.max(0, totalNotes - judgedNotes)
  return clamp01((weightedTally(tally) + missed * JUDGMENT_WEIGHT.miss) / Math.max(1, totalNotes + droppedHolds))
}

function weightedTally(tally: JudgmentTally): number {
  return (
    tally.marvelous * JUDGMENT_WEIGHT.marvelous +
    tally.perfect * JUDGMENT_WEIGHT.perfect +
    tally.great * JUDGMENT_WEIGHT.great +
    tally.good * JUDGMENT_WEIGHT.good +
    tally.miss * JUDGMENT_WEIGHT.miss
  )
}

/** Notes that have been judged at least once, across all tiers. */
export function judgedNotes(tally: JudgmentTally): number {
  return tally.marvelous + tally.perfect + tally.great + tally.good + tally.miss
}

/** StepMania-style combo recognition for a finished run. */
export type ComboRecognition = 'marvelous-full-combo' | 'full-combo' | null

export interface ComboCandidate {
  autoPlay?: boolean
  failed: boolean
  totalNotes: number
  tally: JudgmentTally
  droppedHolds?: number
}

/**
 * Recognise a full combo the way StepMania does: every note in the chart judged, no miss, no
 * dropped hold. All-marvelous earns its own title. Auto-play runs and failed runs can never
 * qualify — a run you did not play (or did not survive) is not a combo.
 */
export function comboRecognition(result: ComboCandidate): ComboRecognition {
  if (result.autoPlay || result.failed) return null
  if (judgedNotes(result.tally) < result.totalNotes) return null
  if (result.tally.miss > 0) return null
  if ((result.droppedHolds ?? 0) > 0) return null
  const imperfect = result.tally.perfect + result.tally.great + result.tally.good
  return imperfect === 0 ? 'marvelous-full-combo' : 'full-combo'
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export interface Grade {
  label: string
  /** 0..1 progress towards the next grade, for the results screen bar. */
  color: string
}

export const GRADES: { min: number; label: string; color: string }[] = [
  { min: 0.995, label: 'SSS', color: '#56b4e9' },
  { min: 0.98, label: 'SS', color: '#42c7a5' },
  { min: 0.95, label: 'S', color: '#009e73' },
  { min: 0.9, label: 'A', color: '#f0e442' },
  { min: 0.8, label: 'B', color: '#e69f00' },
  { min: 0.7, label: 'C', color: '#d98c00' },
  { min: 0.6, label: 'D', color: '#d55e00' },
  { min: 0, label: 'F', color: '#e5484d' },
]

export function gradeFor(accuracy: number, failed = false): Grade {
  if (failed) return { label: 'F', color: '#e5484d' }
  for (const grade of GRADES) {
    if (accuracy >= grade.min) return { label: grade.label, color: grade.color }
  }
  return { label: 'F', color: '#e5484d' }
}

/** Maximum achievable score for a chart, used for the progress bar and the results readout. */
export function maxScore(totalNotes: number): number {
  let score = 0
  for (let i = 0; i < totalNotes; i++) score += noteScore('marvelous', i)
  return score
}

/** Notes-per-second helper used for difficulty readouts. */
export function npsOf(noteCount: number, seconds: number): number {
  return seconds > 0 ? noteCount / seconds : 0
}
