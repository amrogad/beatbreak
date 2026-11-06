import { describe, expect, it } from 'vitest'
import { isOccupied, noteEnd, regridNotes, stepTime, withEnd } from './editNotes'
import { TimingMap } from './timing'
import type { ChartNote, Lane } from '../core/types'

const timing = new TimingMap({ offset: 0, bpms: [{ beat: 0, bpm: 120 }] })

function tap(id: string, lane: Lane, time: number): ChartNote {
  return { id, lane, time, beat: time * 2, step: Math.round(time * 8), kind: 'tap', strength: 1 }
}

describe('editor note helpers', () => {
  it('sees taps on the same spot and inside long arrows as taken', () => {
    const hold = { ...tap('h', 0, 1), kind: 'hold' as const, duration: 1 }
    const notes = [tap('a', 1, 0.5), hold]
    expect(isOccupied(notes, 1, 0.5, 0.5)).toBe(true)
    expect(isOccupied(notes, 1, 0.625, 0.625)).toBe(false)
    expect(isOccupied(notes, 0, 1.5, 1.5)).toBe(true)
    expect(isOccupied(notes, 0, 2.125, 2.125)).toBe(false)
    expect(isOccupied(notes, 0, 1.5, 1.5, 'h')).toBe(false)
  })

  it('turns a long arrow shorter than half a step back into a tap', () => {
    const hold = withEnd(tap('a', 0, 1), 2, timing, 4)
    expect(hold.kind).toBe('hold')
    expect(hold.duration).toBe(1)
    const back = withEnd(hold, 1.05, timing, 4)
    expect(back.kind).toBe('tap')
    expect(back.duration).toBeUndefined()
  })

  it('steps by the tempo at the note', () => {
    const twoTempos = new TimingMap({ offset: 0, bpms: [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }] })
    expect(stepTime(1, 1, twoTempos, 4)).toBeCloseTo(1.125)
    expect(stepTime(3, 1, twoTempos, 4)).toBeCloseTo(3.25)
  })

  it('snaps heads and tails and drops arrows that land on each other', () => {
    const hold = { ...tap('h', 0, 1.01), kind: 'hold' as const, duration: 0.98 }
    const notes = [hold, tap('x', 0, 1.49), tap('y', 1, 0.26), tap('z', 1, 0.24)]
    const result = regridNotes(notes, timing, 4)
    expect(result.dropped).toBe(2)
    const snappedHold = result.notes.find((note) => note.id === 'h') as ChartNote
    expect(snappedHold.time).toBeCloseTo(1)
    expect(noteEnd(snappedHold)).toBeCloseTo(2)
    expect(result.notes.filter((note) => note.lane === 1)).toHaveLength(1)
  })
})
