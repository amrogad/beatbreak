import { describe, expect, it } from 'vitest'
import { buildEditPlan, toPlaybackPlan, type PlaybackPlan } from '../core/edit'
import { PlanClock, SmoothClock, planTimeForSongTime, scrollTimeForSongTime, snapIntoPlayback, songTimeForScrollTime } from './planClock'

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

  it('runs on past both ends for the shifted judge clock, and still jumps at the cut', () => {
    expect(clock.songTimeAtUnclamped(99.97)).toBeCloseTo(9.97, 9)
    expect(clock.songTimeAtUnclamped(104.97)).toBeCloseTo(14.97, 9)
    expect(clock.songTimeAtUnclamped(105.01)).toBeCloseTo(20.01, 9)
    expect(clock.songTimeAtUnclamped(109.5)).toBeCloseTo(24.5, 9)
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

describe('SmoothClock', () => {
  /** A device that renders 10.67 ms bursts with up to 1 ms of callback jitter, read every frame and on input. */
  const simulate = (rate = 1, frames = 3000) => {
    const clock = new SmoothClock()
    const burst = 512 / 48000
    let seed = 7
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const rawAt = (t: number) => Math.floor((t * rate) / burst + random() * 0.09) * burst
    const out: { t: number; raw: number; smooth: number }[] = []
    let t = 1
    for (let i = 0; i < frames; i++) {
      t += 1 / 60 + (random() < 0.3 ? random() * 0.004 : 0)
      const raw = rawAt(t)
      out.push({ t, raw, smooth: clock.read(raw, t * 1000) })
    }
    return out
  }
  const stats = (values: number[]) => {
    const mean = values.reduce((s, v) => s + v, 0) / values.length
    return { mean, sd: Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length) }
  }

  it('removes the steps but keeps the raw clock on average', () => {
    const run = simulate().slice(300)
    const raw = stats(run.map((r) => (r.raw - r.t) * 1000))
    const smooth = stats(run.map((r) => (r.smooth - r.t) * 1000))
    expect(raw.sd).toBeGreaterThan(2.5)
    expect(smooth.sd).toBeLessThan(0.8)
    expect(Math.abs(smooth.mean - raw.mean)).toBeLessThan(1)
  })

  it('never goes backwards', () => {
    const run = simulate()
    for (let i = 1; i < run.length; i++) expect(run[i].smooth).toBeGreaterThanOrEqual(run[i - 1].smooth)
  })

  it('follows an audio clock that runs slower than performance.now()', () => {
    const run = simulate(0.9998, 6000).slice(300)
    const drift = run.map((r) => (r.smooth - r.raw) * 1000)
    expect(Math.max(...drift.slice(-600).map(Math.abs))).toBeLessThan(12)
    expect(Math.abs(stats(drift.slice(-600)).mean)).toBeLessThan(2)
  })

  it('stops with a stalled audio clock instead of running ahead', () => {
    const clock = new SmoothClock()
    for (let i = 0; i < 60; i++) clock.read(Math.floor(i / 0.6) * 0.01, 1000 + i * 1000 / 60)
    const frozen = clock.read(0.99, 2000)
    const later = clock.read(0.99, 3000)
    expect(later - frozen).toBeLessThan(0.09)
    // When the clock moves again the reading carries on from there, not from far ahead.
    expect(clock.read(1.2, 3200)).toBeLessThan(1.21)
  })
})

describe('scroll time (the highway closes cuts up)', () => {
  it('keeps the gap across a cut at its played length', () => {
    // 14.5 is 0.5 s before the join, 20.5 is 0.5 s after it: 1 s apart on the highway.
    expect(scrollTimeForSongTime(plan, 20.5) - scrollTimeForSongTime(plan, 14.5)).toBeCloseTo(1, 9)
  })

  it('runs on before the window and after it', () => {
    expect(scrollTimeForSongTime(plan, 8)).toBeCloseTo(-2, 9)
    expect(scrollTimeForSongTime(plan, 42)).toBeCloseTo(27, 9)
  })

  it('puts a time inside a cut on the join', () => {
    expect(scrollTimeForSongTime(plan, 17)).toBeCloseTo(5, 9)
  })

  it('maps back, giving the later part on a join', () => {
    for (const t of [8, 10, 12.5, 20, 33, 42]) expect(songTimeForScrollTime(plan, scrollTimeForSongTime(plan, t))).toBeCloseTo(t, 9)
    expect(songTimeForScrollTime(plan, 5)).toBeCloseTo(20, 9)
  })

  it('is plain song time with no plan segments', () => {
    expect(scrollTimeForSongTime({ duration: 0, segments: [] }, 12)).toBe(12)
    expect(songTimeForScrollTime({ duration: 0, segments: [] }, 12)).toBe(12)
  })
})
