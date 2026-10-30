import { describe, expect, it } from 'vitest'
import { buildEditPlan, toPlaybackPlan, type PlaybackPlan } from '../core/edit'
import { PlanClock, planTimeForSongTime, snapIntoPlayback } from './planClock'

/** Window 10..40 with the middle 15..20 removed: segments 10..15 and 20..40. */
const plan: PlaybackPlan = toPlaybackPlan(buildEditPlan({ start: 10, end: 40 }, [{ start: 15, end: 20 }], 60))

describe('snapIntoPlayback', () => {
  it('keeps an exact position inside a segment (pause/resume is sample-exact)', () => {
    expect(snapIntoPlayback(plan, 12.5)).toBeCloseTo(12.5, 9)
    expect(snapIntoPlayback(plan, 30)).toBeCloseTo(30, 9)
  })

  it('snaps a position inside a removed interval forward to the join', () => {
    expect(snapIntoPlayback(plan, 17)).toBeCloseTo(20, 9)
    expect(snapIntoPlayback(plan, 19.999)).toBeCloseTo(20, 9)
    // Exactly on the cut's first sample keeps the position; the engine skips the empty segment.
    expect(snapIntoPlayback(plan, 15)).toBeCloseTo(15, 9)
  })

  it('clamps positions outside the window', () => {
    expect(snapIntoPlayback(plan, 0)).toBeCloseTo(10, 9)
    expect(snapIntoPlayback(plan, -5)).toBeCloseTo(10, 9)
    expect(snapIntoPlayback(plan, 99)).toBeCloseTo(40, 9)
  })

  it('handles an empty plan', () => {
    expect(snapIntoPlayback({ duration: 0, segments: [] }, 12)).toBe(0)
  })
})

describe('planTimeForSongTime', () => {
  it('maps original positions onto the edited timeline', () => {
    expect(planTimeForSongTime(plan, 10)).toBeCloseTo(0, 9)
    expect(planTimeForSongTime(plan, 12.5)).toBeCloseTo(2.5, 9)
    expect(planTimeForSongTime(plan, 20)).toBeCloseTo(5, 9) // the join
    expect(planTimeForSongTime(plan, 25)).toBeCloseTo(10, 9)
    expect(planTimeForSongTime(plan, 40)).toBeCloseTo(25, 9)
  })

  it('maps removed positions to the following join and past-the-end to the duration', () => {
    expect(planTimeForSongTime(plan, 17)).toBeCloseTo(5, 9)
    expect(planTimeForSongTime(plan, 99)).toBeCloseTo(25, 9)
  })
})

describe('PlanClock', () => {
  /** Two segments: orig 10..15 playing ctx 100..105, then orig 20..24 playing ctx 105..109. */
  const clock = new PlanClock()
  clock.schedule(
    [
      { pbStart: 0, pbEnd: 5, origStart: 10, origEnd: 15, ctxStart: 100, ctxEnd: 105 },
      { pbStart: 5, pbEnd: 9, origStart: 20, origEnd: 24, ctxStart: 105, ctxEnd: 109 },
    ],
    10,
  )

  it('reports the original-timeline position and jumps over the cut', () => {
    expect(clock.songTimeAt(99)).toBeCloseTo(10, 9) // lookahead: not sounding yet
    expect(clock.songTimeAt(102)).toBeCloseTo(12, 9)
    expect(clock.songTimeAt(104.99)).toBeCloseTo(14.99, 6)
    expect(clock.songTimeAt(105)).toBeCloseTo(20, 9) // the jump
    expect(clock.songTimeAt(107)).toBeCloseTo(22, 9)
    expect(clock.songTimeAt(110)).toBeCloseTo(24, 9) // clamped to the end
  })

  it('reports a continuous edited-timeline position', () => {
    expect(clock.planTimeAt(102)).toBeCloseTo(2, 9)
    expect(clock.planTimeAt(105)).toBeCloseTo(5, 9)
    expect(clock.planTimeAt(107)).toBeCloseTo(7, 9)
    expect(clock.planTimeAt(110)).toBeCloseTo(9, 9)
  })

  it('knows when it has finished', () => {
    expect(clock.finishedAt(108.5)).toBe(false)
    expect(clock.finishedAt(109)).toBe(true)
    expect(clock.finishedAt(120)).toBe(true)
  })

  it('reports the fallback before anything is scheduled', () => {
    const empty = new PlanClock()
    expect(empty.finishedAt(0)).toBe(true)
    empty.schedule([], 7)
    expect(empty.songTimeAt(10)).toBe(7)
  })
})

describe('edit plan building', () => {
  it('maps the window and cuts onto segments and total duration', () => {
    expect(plan.duration).toBeCloseTo(25, 9)
    expect(plan.segments).toEqual([
      { pbStart: 0, pbEnd: 5, origStart: 10, origEnd: 15 },
      { pbStart: 5, pbEnd: 25, origStart: 20, origEnd: 40 },
    ])
  })

  it('a full-song plan is the identity', () => {
    const full = toPlaybackPlan(buildEditPlan({ start: 0, end: 60 }, [], 60))
    expect(full.segments).toEqual([{ pbStart: 0, pbEnd: 60, origStart: 0, origEnd: 60 }])
    expect(snapIntoPlayback(full, 33.3)).toBeCloseTo(33.3, 9)
    expect(planTimeForSongTime(full, 33.3)).toBeCloseTo(33.3, 9)
  })
})
