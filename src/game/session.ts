/**
 * Gameplay session: the rules of a single run.
 *
 * The session is deliberately free of rendering, audio and React. It only knows
 *  - the chart (notes + timing),
 *  - the judgement windows,
 *  - the song time the caller feeds it (milliseconds, already latency-compensated), and
 *  - where the score is (delegated to `score.ts`).
 *
 * That makes the whole run testable with a fake clock, and it guarantees the renderer can never
 * influence hit detection: the renderer reads the session, it never writes to it.
 */
import type { Chart, ChartNote, FailRule, HitEvent, Judgment, JudgmentWindows, Lane, ScoreState } from '../core/types'
import { LANE_COUNT } from '../core/types'
import { isMissed, isWithinHitWindow, judge } from './judgment'
import { applyJudgment, createScoreState, registerHoldDrop } from './score'

export interface GameSessionOptions {
  chart: Chart
  windows: JudgmentWindows
  /**
   * Verification/demo mode: notes are judged Perfect the instant their time arrives.
   * Used by the "auto-play" checkbox so a chart's sync can be checked by ear, and by the
   * automated flow test. It never fabricates a judgement for a note that does not exist.
   */
  autoPlay?: boolean
  /** Fired for every judgement, in judgement order. */
  onJudgment?: (event: HitEvent) => void
  /** A hold was kept down all the way to its tail (StepMania's OK). */
  onHoldComplete?: (lane: Lane) => void
  /** Fired once when the run ends (all notes judged or the tail of the song reached). */
  onComplete?: (state: ScoreState) => void
  /** Extra milliseconds after the last note before the run is forced to end. */
  tailMs?: number
}

export interface TapResult {
  judgment: Judgment
  /** Signed timing error in milliseconds (negative = early). */
  deltaMs: number
  noteId: string
  lane: Lane
}

/**
 * StepMania's default hold window (`TW_Hold` = 0.250 s): how long a released hold keeps its life.
 * The source calls it "allow enough time to take foot off and put back on" — pressing the lane
 * again refills the life, so only a release longer than this fails the hold. When the life runs
 * out, StepMania (dance, `ImmediateHoldLetGo`) scores a LetGo: a miss. We do the same.
 */
export const HOLD_RELEASE_WINDOW_MS = 250
/** Letting go this close to the tail still counts as holding it to the end. */
export const HOLD_TAIL_GRACE_MS = 80

interface ActiveHold {
  index: number
  tailMs: number
  /** Song time the lane key was released, or null while it is held (full life). */
  releasedAt: number | null
}

export class GameSession {
  readonly chart: Chart
  readonly windows: JudgmentWindows
  readonly totalNotes: number
  readonly firstNoteMs: number
  /** Head time of the last note in the chart. */
  readonly lastNoteMs: number
  /** When the chart stops asking for input: the last note's end, so long hold tails count. */
  readonly lastNoteEndMs: number

  private notes: ChartNote[]
  private noteTimesMs: number[]
  private laneNotes: number[][]
  private laneCursor: number[]
  private judged: Uint8Array
  /** Holds whose head was hit and whose tail has not arrived yet, indexed by lane. */
  private activeHolds: (ActiveHold | null)[]
  private judgedCount = 0
  private autoCursor = 0
  private globalCursor = 0
  private state: ScoreState
  private marvelousStreak = 0
  private bestMarvelousStreak = 0
  private deltaSum = 0
  private deltaCount = 0
  private finished = false
  private autoPlay: boolean
  private options: GameSessionOptions

  constructor(options: GameSessionOptions) {
    this.options = options
    this.chart = options.chart
    this.windows = options.windows
    this.autoPlay = options.autoPlay ?? false
    // The chart holds notes sorted by time (an invariant maintained by the generator, the editor
    // and `sanitizeNotes`), but sorting here is cheap and makes the session safe for imported
    // JSON that might have slipped through.
    this.notes = [...options.chart.notes].sort((a, b) => (a.time === b.time ? a.lane - b.lane : a.time - b.time))
    this.noteTimesMs = this.notes.map((n) => n.time * 1000)
    this.totalNotes = this.notes.length
    this.firstNoteMs = this.totalNotes > 0 ? this.noteTimesMs[0] : 0
    this.lastNoteMs = this.totalNotes > 0 ? this.noteTimesMs[this.totalNotes - 1] : 0
    this.lastNoteEndMs =
      this.notes.reduce((end, note) => Math.max(end, note.time + (note.duration ?? 0)), 0) * 1000
    this.laneNotes = Array.from({ length: LANE_COUNT }, () => [] as number[])
    for (let i = 0; i < this.notes.length; i++) this.laneNotes[this.notes[i].lane].push(i)
    this.laneCursor = new Array<number>(LANE_COUNT).fill(0)
    this.activeHolds = new Array(LANE_COUNT).fill(null)
    this.judged = new Uint8Array(this.totalNotes)
    this.state = createScoreState(this.totalNotes)
  }

  setAutoPlay(autoPlay: boolean): void {
    this.autoPlay = autoPlay
  }

  get isAutoPlay(): boolean {
    return this.autoPlay
  }

  get isFinished(): boolean {
    return this.finished
  }

  get scoreState(): ScoreState {
    return this.state
  }

  /** Longest run of consecutive Marvelous judgements (the results screen's "flawless" streak). */
  get maxMarvelousStreak(): number {
    return this.bestMarvelousStreak
  }

  get judgedNotes(): number {
    return this.judgedCount
  }

  /**
   * Mean signed timing error of the notes the player actually hit (ms, negative = early).
   * The results screen uses it to suggest an audio-offset correction; it is deliberately
   * computed only from hits, because misses carry no timing information.
   */
  get meanTimingMs(): number {
    return this.deltaCount > 0 ? this.deltaSum / this.deltaCount : 0
  }

  get timingSampleCount(): number {
    return this.deltaCount
  }

  /** First pending note in a lane with its delta to the given song time; null when the lane is clear. */
  nextNoteInLane(lane: Lane, songTimeMs: number): { note: ChartNote; deltaMs: number } | null {
    for (let k = this.laneCursor[lane]; k < this.laneNotes[lane].length; k++) {
      const index = this.laneNotes[lane][k]
      if (this.judged[index]) continue
      return { note: this.notes[index], deltaMs: this.noteTimesMs[index] - songTimeMs }
    }
    return null
  }

  /**
   * Visit every unjudged note with `time <= untilTimeMs`, oldest first.
   *
   * This is the renderer's read path: it walks forward from a cursor that only ever advances, so
   * drawing a frame costs O(visible notes) and never scans the whole chart. It mutates only that
   * internal cursor — nothing about scoring or judgement state changes.
   */
  forEachPending(untilTimeMs: number, visit: (note: ChartNote) => void): void {
    while (this.globalCursor < this.totalNotes && this.judged[this.globalCursor]) this.globalCursor++
    for (let i = this.globalCursor; i < this.totalNotes; i++) {
      if (this.noteTimesMs[i] > untilTimeMs) break
      if (!this.judged[i]) visit(this.notes[i])
    }
  }

  /**
   * Visit every hold that was hit and is still running (its tail is in the future). The renderer
   * keeps drawing the remaining shaft from the receptors, and `life` < 1 tells it the key was
   * released — the player can still catch the hold by pressing again.
   */
  forEachActiveHold(songTimeMs: number, visit: (note: ChartNote, life: number) => void): void {
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const hold = this.activeHolds[lane]
      if (!hold) continue
      const life =
        hold.releasedAt === null
          ? 1
          : Math.max(0, 1 - (songTimeMs - hold.releasedAt) / HOLD_RELEASE_WINDOW_MS)
      visit(this.notes[hold.index], life)
    }
  }

  /**
   * Advance the clock: resolve misses and (in auto-play) the notes that are due.
   * Safe to call every animation frame; cheap when nothing is pending.
   */
  update(songTimeMs: number): void {
    if (this.finished) return
    if (this.autoPlay) this.runAutoPlay(songTimeMs)
    this.drainHolds(songTimeMs)
    this.expireHolds(songTimeMs)
    this.resolveMisses(songTimeMs)
    this.checkCompletion(songTimeMs)
  }

  /**
   * A lane key was released. The hold does not drop instantly: StepMania drains a hold's life over
   * `TW_Hold` (250 ms), so a brief release — taking a foot off and putting it back on — can be
   * recovered by pressing again. If the life runs out before the tail, `update` scores it as a
   * LetGo. Returns true when a live hold was released.
   */
  releaseLane(lane: Lane, songTimeMs: number): boolean {
    if (this.finished) return false
    const hold = this.activeHolds[lane]
    if (!hold) return false
    if (songTimeMs >= hold.tailMs - HOLD_TAIL_GRACE_MS) {
      // At (or just before) the tail: the hold was completed.
      this.activeHolds[lane] = null
      this.options.onHoldComplete?.(lane)
      return false
    }
    if (hold.releasedAt === null) hold.releasedAt = songTimeMs
    return true
  }

  /**
   * A released hold is a LetGo (a miss) unless it is pressed again within the hold window. The
   * tail arriving while it is still released does not save it: only holding to the end counts.
   */
  private drainHolds(songTimeMs: number): void {
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const hold = this.activeHolds[lane]
      if (!hold || hold.releasedAt === null) continue
      const expiryMs = Math.min(hold.releasedAt + HOLD_RELEASE_WINDOW_MS, hold.tailMs)
      if (songTimeMs < expiryMs) continue
      this.dropHold(lane as Lane, hold)
    }
  }

  private dropHold(lane: Lane, hold: ActiveHold): void {
    this.activeHolds[lane] = null
    const note = this.notes[hold.index]
    const atMs = hold.releasedAt === null ? hold.tailMs : Math.min(hold.tailMs, hold.releasedAt + HOLD_RELEASE_WINDOW_MS)
    this.state = registerHoldDrop(this.state)
    // The combo break and accuracy penalty live in the score state; the event only drives feedback.
    this.emitJudgment('miss', lane, atMs - hold.tailMs, note.id, atMs, true)
  }

  /** Holds whose tail time has arrived while the key was still down are simply completed. */
  private expireHolds(songTimeMs: number): void {
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const hold = this.activeHolds[lane]
      if (hold && songTimeMs >= hold.tailMs) {
        this.activeHolds[lane] = null
        this.options.onHoldComplete?.(lane as Lane)
      }
    }
  }

  /**
   * Judge a lane press.
   *
   * Picks the *nearest* pending note in the lane whose delta is inside the `good` window. Ties go to
   * the earlier note. A press with no candidate returns null and consumes nothing, so mashing can
   * never steal a note that is still far in the future.
   */
  handleTap(lane: Lane, songTimeMs: number): TapResult | null {
    if (this.finished || this.autoPlay) return null
    this.resolveMisses(songTimeMs)

    // Pressing a live hold's lane again refills its hold life (StepMania's re-grab): the press
    // only saves the hold, it cannot also judge the lane's next note.
    const liveHold = this.activeHolds[lane]
    if (liveHold) {
      liveHold.releasedAt = null
      return null
    }

    const window = this.windows.good
    let bestIndex = -1
    let bestDelta = Number.POSITIVE_INFINITY
    const laneIndices = this.laneNotes[lane]
    for (let k = this.laneCursor[lane]; k < laneIndices.length; k++) {
      const index = laneIndices[k]
      if (this.judged[index]) continue
      const delta = songTimeMs - this.noteTimesMs[index]
      if (delta < -window) break // everything later is further in the future
      if (delta > window) continue // stale: past the hit window, will be missed by the session clock
      if (Math.abs(delta) < Math.abs(bestDelta)) {
        bestIndex = index
        bestDelta = delta
      }
    }
    if (bestIndex < 0) return null

    const judgment = judge(bestDelta, this.windows)
    this.commitJudgment(bestIndex, judgment, bestDelta, songTimeMs)
    // A hit hold arms the lane: the key must stay down until the tail arrives.
    const note = this.notes[bestIndex]
    if (judgment !== 'miss' && note.kind === 'hold' && (note.duration ?? 0) > 0) {
      this.activeHolds[lane] = {
        index: bestIndex,
        tailMs: (note.time + (note.duration ?? 0)) * 1000,
        releasedAt: null,
      }
    }
    return { judgment, deltaMs: bestDelta, noteId: note.id, lane }
  }

  /** Restart the run in place (same chart/windows). */
  reset(): void {
    this.judged = new Uint8Array(this.totalNotes)
    this.judgedCount = 0
    this.autoCursor = 0
    this.globalCursor = 0
    this.laneCursor.fill(0)
    this.activeHolds.fill(null)
    this.marvelousStreak = 0
    this.bestMarvelousStreak = 0
    this.deltaSum = 0
    this.deltaCount = 0
    this.finished = false
    this.state = createScoreState(this.totalNotes)
  }

  /**
   * End the run early (the fail rule was met, or the player quit). Only notes whose miss window
   * has already elapsed are scored as misses; notes that never arrived are simply not played.
   * StepMania fails you the moment the rule is met — it does not invent a miss for every arrow
   * left in the chart — so a run that fails after ten misses reports ten misses.
   */
  forfeit(songTimeMs = this.lastNoteEndMs + this.windows.missAfter + 1): void {
    if (this.finished) return
    this.activeHolds.fill(null)
    this.resolveMisses(songTimeMs)
    this.finished = true
    this.options.onComplete?.(this.state)
  }

  private runAutoPlay(songTimeMs: number): void {
    while (this.autoCursor < this.totalNotes && this.noteTimesMs[this.autoCursor] <= songTimeMs) {
      const index = this.autoCursor
      this.autoCursor++
      if (this.judged[index]) continue
      this.commitJudgment(index, 'marvelous', songTimeMs - this.noteTimesMs[index], songTimeMs)
      // Auto-play holds its holds too, so the watch mode shows them being held to the end.
      const note = this.notes[index]
      if (note.kind === 'hold' && (note.duration ?? 0) > 0) {
        this.activeHolds[note.lane] = { index, tailMs: (note.time + (note.duration ?? 0)) * 1000, releasedAt: null }
      }
    }
  }

  private resolveMisses(songTimeMs: number): void {
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const laneIndices = this.laneNotes[lane]
      while (this.laneCursor[lane] < laneIndices.length) {
        const index = laneIndices[this.laneCursor[lane]]
        if (this.judged[index]) {
          this.laneCursor[lane]++
          continue
        }
        const delta = songTimeMs - this.noteTimesMs[index]
        if (!isMissed(delta, this.windows)) break
        // `commitJudgment` moves the cursor past everything already judged, so it must not be
        // advanced again here — doing so would skip the lane's next pending note entirely.
        this.commitJudgment(index, 'miss', delta, songTimeMs)
      }
    }
  }

  private commitJudgment(index: number, judgment: Judgment, deltaMs: number, songTimeMs: number): void {
    if (this.judged[index]) return
    this.judged[index] = 1
    this.judgedCount++
    this.state = applyJudgment(this.state, judgment)
    this.marvelousStreak = judgment === 'marvelous' ? this.marvelousStreak + 1 : 0
    if (this.marvelousStreak > this.bestMarvelousStreak) this.bestMarvelousStreak = this.marvelousStreak
    if (judgment !== 'miss') {
      this.deltaSum += deltaMs
      this.deltaCount++
    }
    // Keep the lane cursor past everything already judged so taps start from a live note.
    const lane = this.notes[index].lane
    const laneIndices = this.laneNotes[lane]
    while (this.laneCursor[lane] < laneIndices.length && this.judged[laneIndices[this.laneCursor[lane]]]) {
      this.laneCursor[lane]++
    }
    this.emitJudgment(judgment, lane, deltaMs, this.notes[index].id, songTimeMs)
  }

  private emitJudgment(
    judgment: Judgment,
    lane: Lane,
    deltaMs: number,
    noteId: string,
    songTimeMs: number,
    holdDrop = false,
  ): void {
    const event: HitEvent = {
      judgment,
      lane,
      deltaMs,
      noteId,
      time: songTimeMs / 1000,
      comboAfter: this.state.combo,
      scoreAfter: this.state.score,
      marvelousStreak: this.marvelousStreak,
      ...(holdDrop ? { holdDrop: true } : {}),
    }
    this.options.onJudgment?.(event)
  }

  private checkCompletion(songTimeMs: number): void {
    if (this.finished) return
    const holdsLive = this.activeHolds.some((hold) => hold !== null)
    const allJudged = this.judgedCount >= this.totalNotes
    const pastTail = songTimeMs > this.lastNoteEndMs + this.windows.missAfter + (this.options.tailMs ?? 1200)
    if (!allJudged && !pastTail) return
    // A hold's head can be judged while its tail is still running. A hold ends at its tail, so the
    // run is not over just because every head has been judged.
    if (holdsLive && !pastTail) return
    if (pastTail && !allJudged) {
      // Notes hidden in a trailing silence still have to be accounted for.
      for (let i = 0; i < this.totalNotes; i++) {
        if (!this.judged[i]) this.commitJudgment(i, 'miss', songTimeMs - this.noteTimesMs[i], songTimeMs)
      }
    }
    this.finished = true
    this.options.onComplete?.(this.state)
  }
}

/** Convenience for UI code that only needs the visuals of a hit window. */
export function isHittable(deltaMs: number, windows: JudgmentWindows): boolean {
  return isWithinHitWindow(deltaMs, windows)
}

/** The arcade accuracy rule: a run fails when this many notes have been judged and it drops below. */
export const FAIL_MIN_JUDGED = 24
export const FAIL_ACCURACY = 0.5

/**
 * Evaluate the fail rule against the live score state. `never` never fails; the numbered rules
 * fail after that many misses (dropped holds count as misses); `accuracy` keeps the arcade
 * behaviour.
 */
export function checkFail(rule: FailRule, state: ScoreState): boolean {
  const misses = state.tally.miss + state.droppedHolds
  switch (rule) {
    case 'never':
      return false
    case 'miss1':
      return misses >= 1
    case 'miss3':
      return misses >= 3
    case 'miss5':
      return misses >= 5
    case 'miss10':
      return misses >= 10
    case 'accuracy':
    default:
      return state.judged >= FAIL_MIN_JUDGED && state.accuracy < FAIL_ACCURACY
  }
}
