/**
 * Layout rules applied to a generated chart, after lanes and holds are chosen.
 *
 * The generator follows the sound, and real music is full of hits a few milliseconds apart. A
 * person charting by hand would never write those as two arrows "almost together", so this pass
 * tidies the chart the way a charter would:
 *
 *  1. Aligned or apart: two arrows either land at the same moment (a chord) or at least one grid
 *     step apart. Near-misses merge into a chord when the chord limit allows, else the weaker
 *     arrow goes.
 *  2. Holds have a minimum length (1 beat Easy, 1/2 Normal, 1/4 Hard and Expert).
 *  3. Easy and Normal: nothing in another column while a hold runs, except exactly at its start
 *     or its end.
 *  4. Hold releases end together or are spaced apart (1 beat Easy, 1/2 Normal, 1/4 Hard, Expert).
 *  5. Easy: at most five arrows in a row at half-beat spacing before a rest.
 *  6. Normal and Hard: no chords in the middle of a fast run.
 *  7. Normal and Hard: no anchors, the same column hammered in a run (3 times in 5 arrows on
 *     Normal, 5 in 9 on Hard: every other arrow on one column).
 *  8. No stray arrow at the very start or end: an arrow two bars or more away from the rest of the
 *     chart (a quiet intro sound, a last ring after the song) is dropped, so the chart starts
 *     when the music does.
 *
 * Rules 2-7 follow the osu!mania ranking criteria for the matching difficulty; rule 1 is
 * Beatbreak's own. Every rule only removes arrows, shortens holds, moves a release onto another
 * arrow or moves an arrow to a free column: it never adds an arrow the music did not have.
 */
import type { ChartNote, Difficulty, Lane } from '../core/types'
import type { TimingMap } from './timing'

export interface RuleSettings {
  stepsPerBeat: number
  maxChord: number
  minJackGap: number
}

const MIN_HOLD_BEATS: Record<Difficulty, number> = { easy: 1, normal: 0.5, hard: 0.25, expert: 0.25 }
const RELEASE_GAP_BEATS: Record<Difficulty, number> = { easy: 1, normal: 0.5, hard: 0.25, expert: 0.25 }
export const ANCHOR_LIMIT: Partial<Record<Difficulty, number>> = { normal: 3, hard: 5 }
/** How many arrows of a run, counting the current one, an anchor is counted over. */
export const anchorWindow = (limit: number): number => limit * 2 - 1
const SAME_TIME = 0.002

const end = (note: ChartNote): number => note.time + (note.kind === 'hold' ? note.duration ?? 0 : 0)
const isHold = (note: ChartNote): boolean => note.kind === 'hold' && (note.duration ?? 0) > 0

function toTap(note: ChartNote): ChartNote {
  const tap: ChartNote = { ...note, kind: 'tap' }
  delete tap.duration
  return tap
}

export function applyChartRules(
  input: ChartNote[],
  timing: TimingMap,
  settings: RuleSettings,
  difficulty: Difficulty,
): ChartNote[] {
  let notes = [...input].sort((a, b) => a.time - b.time || a.lane - b.lane)
  const beatAt = (time: number): number => timing.secondsPerBeat(timing.timeToBeat(time))
  notes = alignOrApart(notes, beatAt, settings)
  notes = holdLengths(notes, beatAt, difficulty)
  if (difficulty === 'easy' || difficulty === 'normal') notes = clearHolds(notes)
  notes = spaceReleases(notes, beatAt, difficulty)
  // Ending a hold together with another can stretch it over arrows: clear those again.
  if (difficulty === 'easy' || difficulty === 'normal') notes = clearHolds(notes)
  if (difficulty === 'easy') notes = restInRuns(notes, beatAt)
  if (difficulty === 'normal' || difficulty === 'hard') notes = noChordsInRuns(notes, beatAt)
  const anchor = ANCHOR_LIMIT[difficulty]
  if (anchor) notes = breakAnchors(notes, beatAt, anchor, settings)
  notes = dropStrays(notes, beatAt)
  notes = capDensity(notes.sort((a, b) => a.time - b.time || a.lane - b.lane))
  return notes.sort((a, b) => a.time - b.time || a.lane - b.lane)
}

/** No more arrows than this in any one second, on any level (Amro, 2026-11-07). */
export const MAX_NOTES_PER_SECOND = 12

/**
 * Over the ceiling, the weakest arrow in the busy second goes first: a chord's extra arrow before
 * a single one, a tap before a long arrow, then the lowest strength.
 */
function capDensity(notes: ChartNote[]): ChartNote[] {
  const out = [...notes]
  let start = 0
  for (let i = 0; i < out.length; i++) {
    while (out[i].time - out[start].time > 1) start++
    if (i - start + 1 <= MAX_NOTES_PER_SECOND) continue
    let worst = start
    let worstScore = Infinity
    for (let k = start; k <= i; k++) {
      const note = out[k]
      const chordMate = (k > 0 && Math.abs(out[k - 1].time - note.time) < 1e-3) || (k + 1 < out.length && Math.abs(out[k + 1].time - note.time) < 1e-3)
      const score = note.strength + (note.kind === 'hold' ? 1 : 0) - (chordMate ? 0.5 : 0)
      if (score < worstScore) {
        worstScore = score
        worst = k
      }
    }
    out.splice(worst, 1)
    i = Math.max(start, worst) - 1
    if (start > i + 1) start = i + 1
  }
  return out
}

/** Two bars, in beats: an arrow at least this far from every other one is a stray. */
const STRAY_GAP_BEATS = 8

function dropStrays(notes: ChartNote[], beatAt: (t: number) => number): ChartNote[] {
  const moments = groups(notes)
  let first = 0
  let last = moments.length - 1
  // At the start the next arrow is measured from this one's start: a long hold over a quiet intro
  // is still a stray. At the end the gap runs from the previous arrow's end.
  while (first < last && moments[first + 1][0].time - moments[first][0].time >= STRAY_GAP_BEATS * beatAt(moments[first][0].time)) first++
  while (last > first) {
    const previousEnd = Math.max(...moments[last - 1].map(end))
    if (moments[last][0].time - previousEnd < STRAY_GAP_BEATS * beatAt(previousEnd)) break
    last--
  }
  return moments.slice(first, last + 1).flat()
}

/** Groups of arrows that share a moment, in time order. */
function groups(notes: ChartNote[]): ChartNote[][] {
  const out: ChartNote[][] = []
  for (const note of notes) {
    const last = out[out.length - 1]
    if (last && Math.abs(note.time - last[0].time) <= SAME_TIME) last.push(note)
    else out.push([note])
  }
  return out
}

const weight = (group: ChartNote[]): number =>
  group.reduce((acc, note) => acc + note.strength + (isHold(note) ? 0.5 : 0), 0)

/** Rule 1: near-simultaneous arrows become one chord or one arrow. */
function alignOrApart(notes: ChartNote[], beatAt: (t: number) => number, settings: RuleSettings): ChartNote[] {
  const result: ChartNote[][] = []
  for (const group of groups(notes)) {
    const previous = result[result.length - 1]
    if (!previous) {
      result.push(group)
      continue
    }
    const step = beatAt(group[0].time) / settings.stepsPerBeat
    const gap = group[0].time - previous[0].time
    if (gap >= step * 0.9 - 1e-6) {
      result.push(group)
      continue
    }
    // Too close to be separate and not together: merge onto the stronger moment if the lanes are
    // free and the chord stays inside the difficulty's limit, else keep only the stronger one.
    const keepFirst = weight(previous) >= weight(group)
    const anchor = keepFirst ? previous : group
    const other = keepFirst ? group : previous
    const lanes = new Set(anchor.map((note) => note.lane))
    const movable = other.filter((note) => !lanes.has(note.lane) && !isHold(note))
    const merged =
      movable.length === other.length && anchor.length + movable.length <= settings.maxChord
        ? [...anchor, ...movable.map((note) => ({ ...note, time: anchor[0].time, beat: anchor[0].beat, step: anchor[0].step }))]
        : anchor
    result[result.length - 1] = merged
  }
  return result.flat()
}

/** Rule 2: holds shorter than the difficulty's minimum become taps. */
function holdLengths(notes: ChartNote[], beatAt: (t: number) => number, difficulty: Difficulty): ChartNote[] {
  return notes.map((note) => {
    if (!isHold(note)) return note
    if ((note.duration ?? 0) >= beatAt(note.time) * MIN_HOLD_BEATS[difficulty] - 1e-6) return note
    return toTap(note)
  })
}

/** Rule 3: nothing strictly inside a hold on Easy and Normal (its start and end moments are fine). */
function clearHolds(notes: ChartNote[]): ChartNote[] {
  const removed = new Set<ChartNote>()
  for (const hold of notes) {
    if (!isHold(hold) || removed.has(hold)) continue
    const start = hold.time + SAME_TIME
    const stop = end(hold) - SAME_TIME
    for (const other of notes) {
      if (other === hold || removed.has(other)) continue
      if (other.time > start && other.time < stop) removed.add(other)
      // A hold that starts before and is still running into this one would also overlap it.
      else if (isHold(other) && other.time < hold.time - SAME_TIME && end(other) > start) removed.add(hold)
    }
  }
  return notes.filter((note) => !removed.has(note))
}

/** Rule 4: hold releases land together or are spaced apart. */
function spaceReleases(notes: ChartNote[], beatAt: (t: number) => number, difficulty: Difficulty): ChartNote[] {
  const holds = notes.filter(isHold).sort((a, b) => end(a) - end(b))
  const replaced = new Map<ChartNote, ChartNote>()
  for (let i = 1; i < holds.length; i++) {
    const earlier = replaced.get(holds[i - 1]) ?? holds[i - 1]
    const later = replaced.get(holds[i]) ?? holds[i]
    if (!isHold(earlier) || !isHold(later)) continue
    const gap = end(later) - end(earlier)
    if (gap <= SAME_TIME || gap >= beatAt(end(earlier)) * RELEASE_GAP_BEATS[difficulty] - 1e-6) continue
    // Too close: end the earlier hold together with the later one when its column is free until
    // then, else shorten it to a clean gap, else it becomes a tap.
    const nextInLane = notes.find((note) => note.lane === earlier.lane && note.time > earlier.time + SAME_TIME)
    const target = end(later)
    if (!nextInLane || nextInLane.time > target + 0.12) {
      replaced.set(earlier, { ...earlier, duration: target - earlier.time })
      continue
    }
    const shortened = end(later) - beatAt(end(earlier)) * RELEASE_GAP_BEATS[difficulty] - earlier.time
    if (shortened >= beatAt(earlier.time) * MIN_HOLD_BEATS[difficulty]) {
      replaced.set(earlier, { ...earlier, duration: shortened })
    } else {
      replaced.set(earlier, toTap(earlier))
    }
  }
  return notes.map((note) => replaced.get(note) ?? note)
}

/** Rule 5 (Easy): at most five arrows in a row at half-beat spacing, then a rest. */
function restInRuns(notes: ChartNote[], beatAt: (t: number) => number): ChartNote[] {
  const kept: ChartNote[] = []
  let run = 0
  let lastTime = -Infinity
  for (const group of groups(notes)) {
    const gap = group[0].time - lastTime
    run = gap <= beatAt(group[0].time) * 0.5 + 1e-3 ? run + 1 : 1
    if (run > 5) {
      // Skipping this arrow is the rest; the next one starts a new run.
      run = 0
      continue
    }
    kept.push(...group)
    lastTime = group[0].time
  }
  return kept
}

/** Rule 6 (Normal, Hard): a chord inside a fast run keeps only its strongest arrow. */
function noChordsInRuns(notes: ChartNote[], beatAt: (t: number) => number): ChartNote[] {
  const all = groups(notes)
  return all.flatMap((group, i) => {
    if (group.length < 2 || i === 0 || i === all.length - 1) return group
    const fast = beatAt(group[0].time) * 0.25 + 1e-3
    const inside = group[0].time - all[i - 1][0].time <= fast && all[i + 1][0].time - group[0].time <= fast
    if (!inside) return group
    return [group.reduce((best, note) => (note.strength > best.strength || isHold(note) ? note : best))]
  })
}

/** Rule 7 (Normal, Hard): move an arrow off a column that a run keeps returning to. */
function breakAnchors(notes: ChartNote[], beatAt: (t: number) => number, limit: number, settings: RuleSettings): ChartNote[] {
  const out = notes.map((note) => ({ ...note }))
  const singles = groups(out).filter((group) => group.length === 1).map((group) => group[0])
  for (let i = 0; i < singles.length; i++) {
    const note = singles[i]
    if (isHold(note)) continue
    // Walk back through the run (half-beat gaps or less) counting this column's visits.
    let count = 1
    let k = i
    const stop = Math.max(0, i - anchorWindow(limit) + 1)
    while (k > stop && singles[k].time - singles[k - 1].time <= beatAt(note.time) * 0.5 + 1e-3) {
      k--
      if (singles[k].lane === note.lane) count++
    }
    if (count < limit) continue
    const busy = new Set<Lane>([singles[i - 1]?.lane, singles[i + 1]?.lane].filter((lane): lane is Lane => lane !== undefined))
    const candidate = ([0, 1, 2, 3] as Lane[]).find(
      (lane) =>
        lane !== note.lane &&
        !busy.has(lane) &&
        !out.some(
          (other) =>
            other !== note &&
            other.lane === lane &&
            ((other.time <= note.time + SAME_TIME && end(other) >= note.time - settings.minJackGap) ||
              Math.abs(other.time - note.time) < settings.minJackGap),
        ),
    )
    if (candidate !== undefined) note.lane = candidate
  }
  return out
}
