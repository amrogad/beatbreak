import type { ChartNote, Lane } from '../core/types'
import type { TimingMap } from './timing'

/** Two arrows in one lane closer than this can't be hit apart, so they count as stacked. */
const MIN_GAP = 0.03

export function noteEnd(note: ChartNote): number {
  return note.kind === 'hold' && note.duration ? note.time + note.duration : note.time
}

/** True when a note at `time..end` in `lane` would touch another note (taps on the same spot or inside a long arrow). */
export function isOccupied(notes: ChartNote[], lane: Lane, time: number, end: number, ignoreId?: string): boolean {
  for (const other of notes) {
    if (other.id === ignoreId || other.lane !== lane) continue
    if (time < noteEnd(other) + MIN_GAP && other.time < end + MIN_GAP) return true
  }
  return false
}

/** Put a note at a new start (and lane), keeping its length; the grid fields follow the time. */
export function placeNote(note: ChartNote, time: number, lane: Lane, timing: TimingMap, stepsPerBeat: number): ChartNote {
  return { ...note, time, lane, beat: timing.timeToBeat(time), step: timing.timeToStep(time, stepsPerBeat) }
}

/** Set where a long arrow ends. Shorter than half a grid step turns it back into a tap. */
export function withEnd(note: ChartNote, end: number, timing: TimingMap, stepsPerBeat: number): ChartNote {
  const step = timing.secondsPerBeat(timing.timeToBeat(note.time)) / stepsPerBeat
  const duration = end - note.time
  if (duration < step * 0.5) {
    const tap: ChartNote = { ...note, kind: 'tap' }
    delete tap.duration
    return tap
  }
  return { ...note, kind: 'hold', duration }
}

/** One grid step earlier or later, following the tempo at the note. */
export function stepTime(time: number, direction: number, timing: TimingMap, stepsPerBeat: number): number {
  return timing.stepToTime(timing.timeToStep(time, stepsPerBeat) + direction, stepsPerBeat)
}

/**
 * Snap every note (and every long arrow's end) onto a grid. Notes that land on top of an earlier
 * one in the same lane are dropped, so the chart never ends up with stacked arrows.
 */
export function regridNotes(
  notes: ChartNote[],
  timing: TimingMap,
  stepsPerBeat: number,
): { notes: ChartNote[]; dropped: number } {
  const snapped = notes.map((note) => {
    const time = timing.snapTime(note.time, stepsPerBeat)
    const placed = placeNote(note, time, note.lane, timing, stepsPerBeat)
    if (note.kind !== 'hold' || !note.duration) return placed
    return withEnd(placed, timing.snapTime(noteEnd(note), stepsPerBeat), timing, stepsPerBeat)
  })
  snapped.sort((a, b) => (a.time === b.time ? a.lane - b.lane : a.time - b.time))
  const kept: ChartNote[] = []
  for (const note of snapped) {
    if (isOccupied(kept, note.lane, note.time, noteEnd(note))) continue
    kept.push(note)
  }
  return { notes: kept, dropped: notes.length - kept.length }
}
