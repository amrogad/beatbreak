import { describe, expect, it, vi } from 'vitest'
import { GameSession, checkFail } from './session'
import { DEFAULT_WINDOWS } from './judgment'
import type { Chart, ChartNote, HitEvent, Lane, ScoreState } from '../core/types'

/** Minimal chart factory: notes are (lane, seconds) pairs on a 120 BPM map. */
const note = (lane: Lane, time: number): ChartNote => ({
  id: `l${lane}@${time}`,
  lane,
  time,
  beat: time * 2,
  step: Math.round(time * 8),
  kind: 'tap',
  strength: 1,
})

function makeChart(entries: [Lane, number][]): Chart {
  const notes = entries.map(([lane, time]) => note(lane, time)).sort((a, b) => a.time - b.time)
  return {
    schema: 1,
    id: 'chart_test_normal',
    songId: 'test',
    difficulty: 'normal',
    title: 'Test Song',
    timing: { offset: 0, bpms: [{ beat: 0, bpm: 120 }] },
    stepsPerBeat: 4,
    notes,
    stats: { noteCount: notes.length, chordNotes: 0, peakNps: 1, avgNps: 1, rating: 3 },
    generator: {
      version: 'test',
      source: 'analysis',
      seed: 1,
      notes: [],
      stepsPerBeat: 4,
      targetNps: 1,
      maxChord: 2,
      minJackGap: 0.2,
      keepRatio: 0.5,
      accent: 1,
    },
    edited: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

interface SessionExtras {
  autoPlay?: boolean
  tailMs?: number
  onJudgment?: (event: HitEvent) => void
  onComplete?: (state: ScoreState) => void
}

function makeSession(entries: [Lane, number][], extra: SessionExtras = {}): GameSession {
  return new GameSession({ chart: makeChart(entries), windows: DEFAULT_WINDOWS, ...extra })
}

describe('tap judgement', () => {
  it('judges a tap dead on as Marvelous', () => {
    const s = makeSession([[0, 1]])
    const result = s.handleTap(0, 1000)
    expect(result).not.toBeNull()
    expect(result!.judgment).toBe('marvelous')
    expect(result!.deltaMs).toBe(0)
    expect(s.scoreState.combo).toBe(1)
    expect(s.judgedNotes).toBe(1)
  })

  it('applies the same window boundaries as the judgement module', () => {
    const atEdge = makeSession([[0, 1]])
    expect(atEdge.handleTap(0, 1000 + DEFAULT_WINDOWS.perfect)!.judgment).toBe('perfect')
    const pastEdge = makeSession([[0, 1]])
    expect(pastEdge.handleTap(0, 1000 + DEFAULT_WINDOWS.perfect + 0.001)!.judgment).toBe('great')
  })

  it('picks the nearest pending note in the lane', () => {
    const s = makeSession([
      [0, 1],
      [0, 1.1],
    ])
    const result = s.handleTap(0, 1070)
    expect(result!.noteId).toBe('l0@1.1') // −30 ms is closer than +70 ms
    expect(result!.deltaMs).toBeCloseTo(-30, 6)
    expect(result!.judgment).toBe('perfect')
  })

  it('ignores taps outside the hit window instead of stealing the note', () => {
    const s = makeSession([[0, 1]])
    // Too early: nothing is consumed, the future note is untouched.
    expect(s.handleTap(0, 1000 - DEFAULT_WINDOWS.good - 20)).toBeNull()
    expect(s.judgedNotes).toBe(0)
    expect(s.handleTap(0, 1000)!.judgment).toBe('marvelous')
  })

  it('records a miss when the last hit window has passed, even if a tap arrives', () => {
    const s = makeSession([[0, 1]])
    expect(s.handleTap(0, 1000 + DEFAULT_WINDOWS.good + 1)).toBeNull()
    expect(s.scoreState.tally.miss).toBe(1)
  })

  it('judges simultaneous notes independently', () => {
    const s = makeSession([
      [0, 1],
      [1, 1],
    ])
    const first = s.handleTap(0, 1000)
    expect(first!.judgment).toBe('marvelous')
    expect(s.nextNoteInLane(0, 1000)).toBeNull()
    expect(s.nextNoteInLane(1, 1000)).not.toBeNull() // the chord partner is untouched
    const second = s.handleTap(1, 1010)
    expect(second!.judgment).toBe('marvelous')
    expect(s.scoreState.tally.marvelous).toBe(2)
  })

  it('does not judge in auto-play mode', () => {
    const s = makeSession([[0, 1]], { autoPlay: true })
    expect(s.handleTap(0, 1000)).toBeNull()
    expect(s.judgedNotes).toBe(0)
  })
})

describe('misses and the read path', () => {
  it('misses a note only after the missAfter window', () => {
    const s = makeSession([[0, 1]])
    s.update(1000 + DEFAULT_WINDOWS.missAfter)
    expect(s.scoreState.tally.miss).toBe(0)
    s.update(1000 + DEFAULT_WINDOWS.missAfter + 1)
    expect(s.scoreState.tally.miss).toBe(1)
    expect(s.scoreState.combo).toBe(0)
  })

  it('reads through forEachPending without judging anything', () => {
    const s = makeSession([
      [0, 1],
      [1, 1.2],
      [2, 1.4],
    ])
    const seen: string[] = []
    s.forEachPending(1300, (n) => seen.push(n.id))
    expect(seen).toEqual(['l0@1', 'l1@1.2'])
    expect(s.judgedNotes).toBe(0) // read path only
    s.handleTap(0, 1000)
    const after: string[] = []
    s.forEachPending(1400, (n) => after.push(n.id))
    expect(after).toEqual(['l1@1.2', 'l2@1.4'])
  })

  it('reports the delta to the next pending note in a lane', () => {
    const s = makeSession([[3, 1]])
    expect(s.nextNoteInLane(3, 900)!.deltaMs).toBeCloseTo(100, 6)
    s.handleTap(3, 1000)
    expect(s.nextNoteInLane(3, 1000)).toBeNull()
  })
})

describe('run lifecycle', () => {
  it('finishes once every note is judged and calls onComplete exactly once', () => {
    const onComplete = vi.fn()
    const s = makeSession(
      [
        [0, 1],
        [1, 1.2],
      ],
      { onComplete },
    )
    s.handleTap(0, 1000)
    s.handleTap(1, 1200)
    expect(s.isFinished).toBe(false)
    s.update(1300)
    expect(s.isFinished).toBe(true)
    expect(onComplete).toHaveBeenCalledTimes(1)
    s.update(9999)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(s.handleTap(0, 1000)).toBeNull()
  })

  it('ends the run by itself when the player stops playing', () => {
    const onComplete = vi.fn()
    const s = makeSession([[0, 1]], { onComplete })
    s.update(1000 + DEFAULT_WINDOWS.missAfter)
    expect(s.isFinished).toBe(false) // the note has not been missed yet
    s.update(1000 + DEFAULT_WINDOWS.missAfter + 1)
    expect(s.isFinished).toBe(true) // the clock missed it, so the run is over
    expect(s.scoreState.tally).toEqual({ marvelous: 0, perfect: 0, great: 0, good: 0, miss: 1 })
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('forfeit stops the run where it is and never invents misses for arrows that never arrived', () => {
    const onComplete = vi.fn()
    const s = makeSession(
      [
        [0, 1],
        [1, 2],
      ],
      { onComplete },
    )
    s.handleTap(0, 1000)
    s.forfeit(1000)
    expect(s.isFinished).toBe(true)
    // The 2 s arrow was never reached: one marvelous note, no phantom miss (the old failure
    // report showed hundreds of misses for arrows the run never got to).
    expect(s.scoreState.tally).toEqual({ marvelous: 1, perfect: 0, great: 0, good: 0, miss: 0 })
    expect(s.judgedNotes).toBe(1)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(s.handleTap(1, 2000)).toBeNull()
  })

  it('forfeit still counts a note whose miss window already closed', () => {
    const s = makeSession([
      [0, 1],
      [1, 2],
    ])
    s.forfeit(1000 + DEFAULT_WINDOWS.missAfter + 1)
    expect(s.scoreState.tally.miss).toBe(1)
    expect(s.judgedNotes).toBe(1)
  })

  it('resets in place for a restart', () => {
    const s = makeSession([
      [0, 1],
      [1, 1.2],
    ])
    s.handleTap(0, 1010)
    s.update(1500)
    expect(s.judgedNotes).toBe(2)
    s.reset()
    expect(s.isFinished).toBe(false)
    expect(s.scoreState.score).toBe(0)
    expect(s.scoreState.combo).toBe(0)
    expect(s.scoreState.tally).toEqual({ marvelous: 0, perfect: 0, great: 0, good: 0, miss: 0 })
    expect(s.judgedNotes).toBe(0)
    expect(s.maxMarvelousStreak).toBe(0)
    expect(s.meanTimingMs).toBe(0)
    expect(s.timingSampleCount).toBe(0)
    // And it is immediately playable again.
    expect(s.handleTap(0, 1000)!.judgment).toBe('marvelous')
  })
})

describe('scoring through a run', () => {
  it('tracks combo, score and tally through taps and a miss', () => {
    const s = makeSession([
      [0, 1],
      [0, 1.2],
      [0, 1.4],
      [0, 1.6],
      [0, 1.8],
    ])
    s.handleTap(0, 1000) // marvelous, combo 0 → 1, +100
    s.handleTap(0, 1200) // marvelous, combo 1 → 2, +100
    s.handleTap(0, 1460) // great (delta +60, the edge), combo 2 → 3, +72
    s.update(1600 + DEFAULT_WINDOWS.missAfter + 1) // the 1.6 s note is missed
    s.handleTap(0, 1800) // marvelous again, combo reset to 0 → +100
    const state = s.scoreState
    expect(state.tally).toEqual({ marvelous: 3, perfect: 0, great: 1, good: 0, miss: 1 })
    expect(state.combo).toBe(1)
    expect(state.bestCombo).toBe(3)
    expect(state.score).toBe(100 + 100 + 72 + 100)
  })

  it('keeps the combo for low hit tiers and breaks it on a miss', () => {
    const s = makeSession([
      [0, 1],
      [0, 1.2],
      [0, 1.4],
      [0, 1.6],
    ])
    s.handleTap(0, 1000) // marvelous
    s.handleTap(0, 1200) // marvelous
    expect(s.scoreState.combo).toBe(2)
    s.handleTap(0, 1320) // note 1.4 is 80 ms early → good (edge of the window), combo survives
    expect(s.scoreState.combo).toBe(3)
    const before = s.scoreState.score
    s.update(1600 + DEFAULT_WINDOWS.missAfter + 1) // the 1.6 s note misses → combo breaks
    expect(s.scoreState.combo).toBe(0)
    expect(s.scoreState.tally.good).toBe(1)
    expect(s.scoreState.tally.miss).toBe(1)
    expect(s.scoreState.score).toBe(before) // the miss itself scores nothing
  })

  it('tracks mean timing of hit notes only', () => {
    const s = makeSession([
      [0, 1],
      [0, 1.2],
      [0, 1.4],
    ])
    s.handleTap(0, 1010) // +10
    s.handleTap(0, 1230) // +30
    s.update(1400 + DEFAULT_WINDOWS.missAfter + 1) // third note missed
    expect(s.scoreState.tally.miss).toBe(1)
    expect(s.timingSampleCount).toBe(2)
    expect(s.meanTimingMs).toBeCloseTo(20, 9)
  })

  it('tracks the longest marvelous streak', () => {
    const s = makeSession([
      [0, 1],
      [0, 1.1],
      [0, 1.2],
      [0, 1.3],
    ])
    s.handleTap(0, 1000)
    s.handleTap(0, 1100)
    s.handleTap(0, 1230) // delta +30 → perfect breaks the marvelous streak
    s.handleTap(0, 1300)
    expect(s.maxMarvelousStreak).toBe(2)
    expect(s.scoreState.combo).toBe(4) // every hit tier keeps the combo alive
  })
})

describe('auto-play (verify) mode', () => {
  it('judges notes marvelous as the song clock passes them', () => {
    const events: HitEvent[] = []
    const onComplete = vi.fn()
    const s = makeSession(
      [
        [0, 1],
        [2, 1.25],
      ],
      { autoPlay: true, onJudgment: (e) => events.push(e), onComplete },
    )
    s.update(900)
    expect(s.judgedNotes).toBe(0)
    s.update(1000)
    expect(s.judgedNotes).toBe(1)
    s.update(1250)
    expect(s.judgedNotes).toBe(2)
    expect(events.map((e) => `${e.judgment}@${e.lane}`)).toEqual(['marvelous@0', 'marvelous@2'])
    expect(events.every((e) => e.deltaMs === 0)).toBe(true)
    expect(s.isFinished).toBe(true)
    expect(onComplete).toHaveBeenCalledTimes(1)
  })

  it('can be switched off mid-run', () => {
    const s = makeSession(
      [
        [0, 1],
        [0, 1.2],
      ],
      { autoPlay: true },
    )
    s.update(1000) // first note auto-judged
    s.setAutoPlay(false)
    expect(s.isAutoPlay).toBe(false)
    s.update(1400) // the clock has to do the rest
    expect(s.scoreState.tally).toEqual({ marvelous: 1, perfect: 0, great: 0, good: 0, miss: 1 })
  })
})

describe('hold notes', () => {
  /** A chart with one hold in lane 0 (head at 1 s) plus any extra tap notes. */
  const holdChart = (duration: number, extras: [Lane, number][] = []): Chart => {
    const notes: ChartNote[] = [
      { id: 'hold0', lane: 0, time: 1, beat: 2, step: 8, kind: 'hold', strength: 1, duration },
      ...extras.map(([lane, time]) => note(lane, time)),
    ]
    notes.sort((a, b) => a.time - b.time)
    return {
      ...makeChart([]),
      notes,
      stats: { noteCount: notes.length, chordNotes: 0, peakNps: 1, avgNps: 1, rating: 3 },
    }
  }
  const holdSession = (duration: number, extras: [Lane, number][] = []): GameSession =>
    new GameSession({ chart: holdChart(duration, extras), windows: DEFAULT_WINDOWS })

  it('judges a hold twice: the press at the head and the release at the tail', () => {
    const events: HitEvent[] = []
    const completed: number[] = []
    const s = new GameSession({
      chart: holdChart(1), // tail at 2000 ms
      windows: DEFAULT_WINDOWS,
      onJudgment: (e) => events.push(e),
      onHoldComplete: (lane) => completed.push(lane),
    })
    expect(s.scoreState.totalNotes).toBe(2)
    s.handleTap(0, 1000)
    s.update(1900)
    expect(s.releaseLane(0, 2005)).toBe(true) // 5 ms late on the release
    expect(events.map((e) => e.judgment)).toEqual(['marvelous', 'marvelous'])
    expect(events[1].noteId).toBe('hold0#tail')
    expect(s.scoreState.combo).toBe(2)
    expect(completed).toEqual([0])
  })

  it('judges the release on windows half again as wide as the press', () => {
    const s = holdSession(1)
    s.handleTap(0, 1000)
    const late = DEFAULT_WINDOWS.good * 1.4 // outside the press window, inside the release window
    s.releaseLane(0, 2000 + late)
    expect(s.scoreState.tally.good).toBe(1)
    expect(s.scoreState.tally.miss).toBe(0)
  })

  it('a release before the release window is a LET GO miss, with no grabbing it again', () => {
    const events: HitEvent[] = []
    const s = new GameSession({ chart: holdChart(1), windows: DEFAULT_WINDOWS, onJudgment: (e) => events.push(e) })
    s.handleTap(0, 1000)
    s.releaseLane(0, 1500)
    expect(events.map((e) => e.judgment)).toEqual(['marvelous', 'miss'])
    expect(events[1].holdDrop).toBe(true)
    expect(s.scoreState.combo).toBe(0)
    expect(s.handleTap(0, 1550)).toBeNull() // pressing again does nothing: the hold is gone
    s.update(2500)
    expect(s.scoreState.tally.miss).toBe(1)
  })

  it('holding past the release window is a miss', () => {
    const s = holdSession(1)
    s.handleTap(0, 1000)
    s.update(2000 + DEFAULT_WINDOWS.good * 1.5 + 1)
    expect(s.scoreState.tally.miss).toBe(1)
    expect(s.scoreState.combo).toBe(0)
    expect(s.releaseLane(0, 2300)).toBe(false) // already judged
  })

  it('a missed head costs the release as well', () => {
    const s = holdSession(1)
    s.update(1000 + DEFAULT_WINDOWS.missAfter + 1)
    expect(s.scoreState.tally.miss).toBe(2)
    expect(s.releaseLane(0, 2000)).toBe(false)
  })

  it('ignores releases in lanes with no live hold', () => {
    const s = holdSession(1)
    expect(s.releaseLane(2, 1500)).toBe(false)
    expect(s.scoreState.tally.miss).toBe(0)
  })

  it('clears live holds on forfeit and reset', () => {
    const forfeited = holdSession(1, [[1, 4]])
    forfeited.handleTap(0, 1000)
    forfeited.forfeit(1500)
    expect(forfeited.releaseLane(0, 2000)).toBe(false)
    const restarted = holdSession(1, [[1, 4]])
    restarted.handleTap(0, 1000)
    restarted.reset()
    expect(restarted.releaseLane(0, 2000)).toBe(false)
    expect(restarted.scoreState.tally.miss).toBe(0)
  })

  it('auto-play holds and releases on time', () => {
    const chart = holdChart(1)
    const s = new GameSession({ chart, windows: DEFAULT_WINDOWS, autoPlay: true })
    s.update(1000)
    s.update(2000)
    expect(s.scoreState.tally.marvelous).toBe(2)
    expect(s.scoreState.combo).toBe(2)
  })
})
