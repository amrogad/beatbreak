/**
 * The rules of a circle mode run: click or tap each circle as its ring closes, follow sliders.
 *
 * Same contract as `GameSession`: no rendering, audio or React; the caller feeds song time in ms
 * (latency-compensated) and pointer positions in field units (0-512 x 0-384).
 *
 * Judging:
 *  - A press hits the earliest pending circle that is under the cursor and inside the hit window.
 *    A press anywhere else is ignored, so a stray click never costs a circle.
 *  - A slider is two judgements, like a long arrow: its head, and following the ball to the end.
 *    Letting go, or leaving the follow circle, for longer than a short grace breaks it (a miss).
 */
import type { Chart, HitEvent, Judgment, JudgmentWindows, Lane, ScoreState } from '../core/types'
import { sliderBall, sliderExit, type CircleMap, type CircleObject, type CirclePoint } from '../chart/circles'
import { isMissed, judge } from './judgment'
import { DIFFICULTY_SCORE_SCALE, applyJudgment, createScoreState } from './score'

export interface CircleSessionOptions {
  chart: Chart
  map: CircleMap
  windows: JudgmentWindows
  autoPlay?: boolean
  onJudgment?: (event: HitEvent) => void
  onSliderComplete?: (object: CircleObject) => void
  /** A press that judged nothing: too early on a circle, off every circle that was due, or nothing due. */
  onIgnoredPress?: (reason: IgnoredPress, object: CircleObject | null, at: CirclePoint) => void
  onComplete?: (state: ScoreState) => void
  tailMs?: number
}

/** Time a slider forgives a lifted button or a cursor outside the follow circle. */
export const SLIDER_GRACE_MS = 120
/** Letting go this close to a slider's end still completes it. */
export const SLIDER_END_LENIENCY_MS = 80
/** A press on a circle earlier than its Good window but within this many ms misses it. */
export function earlyMissMs(goodMs: number): number {
  return Math.max(250, goodMs * 2.5)
}

/** A press counts this far outside the circle's edge, in field units (fingers and fast flicks). */
const HIT_SLACK = 4

export type IgnoredPress = 'early' | 'off' | 'stray'

/** What every press of a run did, so the results can say why circles were not hit. */
export interface ClickStats {
  hit: number
  early: number
  off: number
  stray: number
}

/** One press, for the local play log: what it did and the circle it was nearest to in time. */
export interface PressLog {
  t: number
  x: number
  y: number
  result: Judgment | IgnoredPress
  /** Nearest unjudged circle in time (the one hit, for a hit). */
  id: string | null
  deltaMs: number | null
  /** Distance from that circle's centre, in circle radii. */
  radii: number | null
}

/** Where the pointer was, every LOG_PATH_MS of song time, flattened as t, x, y. */
const LOG_PATH_MS = 33

interface ActiveSlider {
  index: number
  endMs: number
  /** When the cursor or the button was lost, or null while following. */
  lostAt: number | null
}

export class CircleSession {
  readonly chart: Chart
  readonly map: CircleMap
  readonly windows: JudgmentWindows
  readonly totalNotes: number
  readonly sliderCount: number
  readonly firstNoteMs: number
  readonly lastNoteEndMs: number

  private objects: CircleObject[]
  private timesMs: number[]
  private judged: Uint8Array
  private cursor = 0
  private autoCursor = 0
  private active: ActiveSlider | null = null
  private pointer: CirclePoint = { x: 256, y: 192 }
  private held = false
  private clicks: ClickStats = { hit: 0, early: 0, off: 0, stray: 0 }
  /** Every press, judgement and pointer position of the run, for the local play log. */
  readonly log: { presses: PressLog[]; judgments: { id: string; judgment: Judgment; deltaMs: number; t: number }[]; path: number[] } = { presses: [], judgments: [], path: [] }
  private lastPathMs = -Infinity
  private judgedCount = 0
  private state: ScoreState
  private marvelousStreak = 0
  private bestMarvelousStreak = 0
  private deltaSum = 0
  private deltaCount = 0
  private finished = false
  private autoPlay: boolean
  private options: CircleSessionOptions

  constructor(options: CircleSessionOptions) {
    this.options = options
    this.chart = options.chart
    this.map = options.map
    this.windows = options.windows
    this.autoPlay = options.autoPlay ?? false
    this.objects = [...options.map.objects].sort((a, b) => a.time - b.time)
    this.timesMs = this.objects.map((o) => o.time * 1000)
    this.totalNotes = this.objects.length
    this.sliderCount = this.objects.filter((o) => o.kind === 'slider').length
    this.firstNoteMs = this.totalNotes > 0 ? this.timesMs[0] : 0
    this.lastNoteEndMs = this.objects.reduce((end, o) => Math.max(end, o.endTime), 0) * 1000
    this.judged = new Uint8Array(this.totalNotes)
    this.state = this.freshState()
  }

  private freshState(): ScoreState {
    return createScoreState(this.totalNotes + this.sliderCount, DIFFICULTY_SCORE_SCALE[this.chart.difficulty] ?? 1)
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

  get maxMarvelousStreak(): number {
    return this.bestMarvelousStreak
  }

  get meanTimingMs(): number {
    return this.deltaCount > 0 ? this.deltaSum / this.deltaCount : 0
  }

  get clickStats(): ClickStats {
    return { ...this.clicks }
  }

  get isHeld(): boolean {
    return this.held
  }

  get pointerPosition(): CirclePoint {
    return this.pointer
  }

  /** The slider being followed right now, if any. */
  get activeSlider(): CircleObject | null {
    return this.active ? this.objects[this.active.index] : null
  }

  /** Whether the active slider is being followed (for the follow-circle glow). */
  get isFollowing(): boolean {
    return this.active !== null && this.active.lostAt === null
  }

  /**
   * Visit every object the player should see: unjudged ones whose approach has started, in time
   * order. Judged ones are drawn by the renderer's own fade-outs.
   */
  forEachVisible(songTimeMs: number, visit: (object: CircleObject, index: number) => void): void {
    const until = songTimeMs + this.map.preemptMs
    for (let i = this.cursor; i < this.totalNotes; i++) {
      if (this.timesMs[i] > until) break
      if (!this.judged[i]) visit(this.objects[i], i)
    }
  }

  /** Objects from `from` on, unjudged or not, for drawing follow points between neighbours. */
  objectAt(index: number): CircleObject | undefined {
    return this.objects[index]
  }

  get firstPendingIndex(): number {
    return this.cursor
  }

  /**
   * Where auto-play's cursor is: on the slider ball while one runs, otherwise gliding from the last
   * object's exit to the next object so it lands exactly on time.
   */
  autoPointer(songTimeMs: number): CirclePoint {
    if (this.active) return sliderBall(this.objects[this.active.index], songTimeMs / 1000)
    let next = this.autoCursor
    while (next < this.totalNotes && this.timesMs[next] < songTimeMs) next++
    if (next >= this.totalNotes) return this.totalNotes ? sliderExit(this.objects[this.totalNotes - 1]) : this.pointer
    const target = this.objects[next]
    if (next === 0) return { x: target.x, y: target.y }
    const prev = this.objects[next - 1]
    const from = sliderExit(prev)
    const startMs = prev.endTime * 1000
    const span = this.timesMs[next] - startMs
    const t = span <= 0 ? 1 : Math.max(0, Math.min(1, (songTimeMs - startMs) / span))
    const ease = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
    return { x: from.x + (target.x - from.x) * ease, y: from.y + (target.y - from.y) * ease }
  }

  /** The pointer moved (field units). */
  move(x: number, y: number): void {
    this.pointer = { x, y }
  }

  /**
   * A button, key or finger went down at the current pointer. Returns the judgement, or null when
   * nothing was in reach (the press is then simply ignored).
   */
  press(x: number, y: number, songTimeMs: number): { judgment: Judgment; deltaMs: number; object: CircleObject } | null {
    this.pointer = { x, y }
    this.held = true
    if (this.finished || this.autoPlay) return null
    this.resolveMisses(songTimeMs)
    const reach = this.map.radius + HIT_SLACK
    for (let i = this.cursor; i < this.totalNotes; i++) {
      const delta = songTimeMs - this.timesMs[i]
      if (delta < -this.windows.good) break
      if (this.judged[i] || delta > this.windows.good) continue
      const object = this.objects[i]
      if (Math.hypot(object.x - x, object.y - y) > reach) continue
      const judgment = judge(delta, this.windows)
      this.clicks.hit++
      this.log.presses.push({ t: songTimeMs, x, y, result: judgment, id: object.id, deltaMs: delta, radii: Math.hypot(object.x - x, object.y - y) / this.map.radius })
      this.commit(i, judgment, delta, songTimeMs)
      if (object.kind === 'slider' && judgment !== 'miss') {
        this.active = { index: i, endMs: object.endTime * 1000, lostAt: null }
      }
      return { judgment, deltaMs: delta, object }
    }
    this.ignore(x, y, songTimeMs, reach)
    return null
  }

  /** Sort out why a press hit nothing: the player gets a cue and the results get the count. */
  private ignore(x: number, y: number, songTimeMs: number, reach: number): void {
    let reason: IgnoredPress = 'stray'
    let target: CircleObject | null = null
    let targetIndex = -1
    let targetDelta = 0
    for (let i = this.cursor; i < this.totalNotes; i++) {
      const delta = songTimeMs - this.timesMs[i]
      if (delta < -this.map.preemptMs) break
      if (this.judged[i]) continue
      const object = this.objects[i]
      if (delta >= -this.windows.good) {
        if (reason === 'stray') reason = 'off'
        continue
      }
      if (Math.hypot(object.x - x, object.y - y) <= reach) {
        reason = 'early'
        target = object
        targetIndex = i
        targetDelta = delta
        break
      }
    }
    this.clicks[reason]++
    let nearest: { object: CircleObject; delta: number } | null = null
    for (let i = this.cursor; i < this.totalNotes; i++) {
      const delta = songTimeMs - this.timesMs[i]
      if (delta < -this.map.preemptMs) break
      if (!this.judged[i] && (!nearest || Math.abs(delta) < Math.abs(nearest.delta))) nearest = { object: this.objects[i], delta }
    }
    this.log.presses.push({
      t: songTimeMs,
      x,
      y,
      result: reason,
      id: nearest?.object.id ?? null,
      deltaMs: nearest?.delta ?? null,
      radii: nearest ? Math.hypot(nearest.object.x - x, nearest.object.y - y) / this.map.radius : null,
    })
    // Too early but close to its time (osu!'s rule): the circle is missed, so mashing while
    // aiming costs something. Earlier than that it only shakes.
    if (target && targetDelta >= -earlyMissMs(this.windows.good)) {
      this.commit(targetIndex, 'miss', targetDelta, songTimeMs)
      return
    }
    this.options.onIgnoredPress?.(reason, target, { x, y })
  }

  /** Every button, key and finger is up. */
  release(songTimeMs: number): void {
    this.held = false
    if (this.active && this.active.lostAt === null) this.active.lostAt = songTimeMs
  }

  update(songTimeMs: number): void {
    if (this.finished) return
    if (this.autoPlay) this.runAutoPlay(songTimeMs)
    else if (songTimeMs - this.lastPathMs >= LOG_PATH_MS) {
      this.lastPathMs = songTimeMs
      this.log.path.push(Math.round(songTimeMs), Math.round(this.pointer.x), Math.round(this.pointer.y))
    }
    this.trackSlider(songTimeMs)
    this.resolveMisses(songTimeMs)
    this.checkCompletion(songTimeMs)
  }

  private trackSlider(songTimeMs: number): void {
    const active = this.active
    if (!active) return
    const object = this.objects[active.index]
    if (this.autoPlay) {
      if (songTimeMs >= active.endMs) this.finishSlider('marvelous', songTimeMs)
      return
    }
    const ball = sliderBall(object, Math.min(songTimeMs, active.endMs) / 1000)
    const inside = this.held && Math.hypot(this.pointer.x - ball.x, this.pointer.y - ball.y) <= this.map.followRadius
    if (inside) active.lostAt = null
    else if (active.lostAt === null) active.lostAt = songTimeMs
    const lostFor = active.lostAt === null ? 0 : songTimeMs - active.lostAt
    if (active.lostAt !== null && lostFor > SLIDER_GRACE_MS && active.lostAt < active.endMs - SLIDER_END_LENIENCY_MS) {
      this.finishSlider('miss', songTimeMs, true)
      return
    }
    if (songTimeMs >= active.endMs) this.finishSlider('marvelous', songTimeMs)
  }

  private finishSlider(judgment: Judgment, songTimeMs: number, broke = false): void {
    const active = this.active
    if (!active) return
    this.active = null
    const object = this.objects[active.index]
    this.state = applyJudgment(this.state, judgment)
    this.marvelousStreak = judgment === 'marvelous' ? this.marvelousStreak + 1 : 0
    if (this.marvelousStreak > this.bestMarvelousStreak) this.bestMarvelousStreak = this.marvelousStreak
    this.emit(judgment, object, songTimeMs - active.endMs, `${object.id}#tail`, songTimeMs, broke)
    if (judgment !== 'miss') this.options.onSliderComplete?.(object)
  }

  reset(): void {
    this.judged = new Uint8Array(this.totalNotes)
    this.judgedCount = 0
    this.cursor = 0
    this.autoCursor = 0
    this.active = null
    this.held = false
    this.clicks = { hit: 0, early: 0, off: 0, stray: 0 }
    this.log.presses = []
    this.log.judgments = []
    this.log.path = []
    this.lastPathMs = -Infinity
    this.marvelousStreak = 0
    this.bestMarvelousStreak = 0
    this.deltaSum = 0
    this.deltaCount = 0
    this.finished = false
    this.state = this.freshState()
  }

  forfeit(songTimeMs = this.lastNoteEndMs + this.windows.missAfter + 1): void {
    if (this.finished) return
    this.active = null
    this.resolveMisses(songTimeMs)
    this.finished = true
    this.options.onComplete?.(this.state)
  }

  private runAutoPlay(songTimeMs: number): void {
    while (this.autoCursor < this.totalNotes && this.timesMs[this.autoCursor] <= songTimeMs) {
      const index = this.autoCursor
      this.autoCursor++
      if (this.judged[index]) continue
      // A slider still running when the next circle is due ends now (it never should: placement
      // keeps a gap after every slider).
      if (this.active) this.finishSlider('marvelous', songTimeMs)
      this.commit(index, 'marvelous', songTimeMs - this.timesMs[index], songTimeMs)
      const object = this.objects[index]
      if (object.kind === 'slider') this.active = { index, endMs: object.endTime * 1000, lostAt: null }
    }
  }

  private resolveMisses(songTimeMs: number): void {
    while (this.cursor < this.totalNotes) {
      if (this.judged[this.cursor]) {
        this.cursor++
        continue
      }
      const delta = songTimeMs - this.timesMs[this.cursor]
      if (!isMissed(delta, this.windows)) break
      this.commit(this.cursor, 'miss', delta, songTimeMs)
    }
  }

  private commit(index: number, judgment: Judgment, deltaMs: number, songTimeMs: number): void {
    if (this.judged[index]) return
    this.judged[index] = 1
    this.judgedCount++
    const object = this.objects[index]
    this.state = applyJudgment(this.state, judgment)
    // A missed slider head loses its end too: the slider is never played.
    if (judgment === 'miss' && object.kind === 'slider') this.state = applyJudgment(this.state, 'miss')
    this.marvelousStreak = judgment === 'marvelous' ? this.marvelousStreak + 1 : 0
    if (this.marvelousStreak > this.bestMarvelousStreak) this.bestMarvelousStreak = this.marvelousStreak
    if (judgment !== 'miss') {
      this.deltaSum += deltaMs
      this.deltaCount++
    }
    while (this.cursor < this.totalNotes && this.judged[this.cursor]) this.cursor++
    this.emit(judgment, object, deltaMs, object.id, songTimeMs)
  }

  private emit(judgment: Judgment, object: CircleObject, deltaMs: number, noteId: string, songTimeMs: number, broke = false): void {
    this.log.judgments.push({ id: noteId, judgment, deltaMs: Math.round(deltaMs), t: Math.round(songTimeMs) })
    this.options.onJudgment?.({
      judgment,
      lane: object.color as Lane,
      deltaMs,
      noteId,
      time: songTimeMs / 1000,
      comboAfter: this.state.combo,
      scoreAfter: this.state.score,
      marvelousStreak: this.marvelousStreak,
      ...(broke ? { holdDrop: true } : {}),
    })
  }

  private checkCompletion(songTimeMs: number): void {
    if (this.finished) return
    const allJudged = this.judgedCount >= this.totalNotes
    const pastTail = songTimeMs > this.lastNoteEndMs + this.windows.missAfter + (this.options.tailMs ?? 1200)
    if (!allJudged && !pastTail) return
    if (this.active && !pastTail) return
    if (pastTail && !allJudged) {
      for (let i = 0; i < this.totalNotes; i++) if (!this.judged[i]) this.commit(i, 'miss', songTimeMs - this.timesMs[i], songTimeMs)
    }
    this.finished = true
    this.options.onComplete?.(this.state)
  }
}
