import { describe, expect, it } from 'vitest'
import type { Chart, ChartNote, HitEvent, Lane } from '../core/types'
import { placeCircles, sliderBall, type CircleMap } from '../chart/circles'
import { CircleSession } from './circleSession'
import { DEFAULT_WINDOWS } from './judgment'

const tap = (time: number, lane: Lane = 0): ChartNote => ({ id: `t${time}`, lane, time, beat: time * 2, step: Math.round(time * 8), kind: 'tap', strength: 0.7 })
const hold = (time: number, duration: number): ChartNote => ({ ...tap(time), id: `h${time}`, kind: 'hold', duration })

function chartOf(notes: ChartNote[], difficulty: Chart['difficulty'] = 'normal'): Chart {
  return {
    schema: 1,
    id: `c-${difficulty}`,
    songId: 's',
    difficulty,
    title: 't',
    timing: { offset: 0, bpms: [{ beat: 0, bpm: 120 }] },
    stepsPerBeat: 4,
    notes,
    stats: { noteCount: notes.length, chordNotes: 0, peakNps: 0, avgNps: 0, rating: 1 },
    generator: { version: 'test', source: 'manual', notes: [], stepsPerBeat: 4, targetNps: 0, maxChord: 1, minJackGap: 0, keepRatio: 1, accent: 0, seed: 1 },
    edited: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

const fixedMap = (objects: CircleMap['objects']): CircleMap => ({ objects, radius: 36, preemptMs: 1200, fadeInMs: 800, followRadius: 86 })
const circle = (id: string, time: number, x: number, y: number) => ({ id, time, x, y, kind: 'circle' as const, endTime: time, slides: 1, number: 1, color: 0, strength: 1 })

function run(map: CircleMap, chart: Chart) {
  const events: HitEvent[] = []
  const session = new CircleSession({ chart, map, windows: DEFAULT_WINDOWS, onJudgment: (e) => events.push(e) })
  return { session, events }
}

describe('circle session', () => {
  const chart = chartOf([tap(1), tap(2)])
  const map = fixedMap([circle('a', 1, 100, 100), circle('b', 2, 300, 200)])

  it('hits a circle under the cursor inside the window', () => {
    const { session, events } = run(map, chart)
    expect(session.press(102, 98, 1005)?.judgment).toBe('marvelous')
    expect(events[0].noteId).toBe('a')
  })

  it('ignores a press away from the circle and does not consume it', () => {
    const { session, events } = run(map, chart)
    expect(session.press(200, 200, 1000)).toBeNull()
    expect(events).toHaveLength(0)
    expect(session.press(100, 100, 1010)?.judgment).toBe('marvelous')
  })

  it('tells apart presses that were too early, off the circle, or with nothing due', () => {
    const ignored: string[] = []
    const session = new CircleSession({ chart, map, windows: DEFAULT_WINDOWS, onIgnoredPress: (reason) => ignored.push(reason) })
    expect(session.press(100, 100, 600)).toBeNull()
    expect(session.press(250, 250, 1000)).toBeNull()
    expect(session.press(100, 100, -500)).toBeNull()
    expect(session.press(100, 100, 1000)?.judgment).toBe('marvelous')
    expect(ignored).toEqual(['early', 'off', 'stray'])
    expect(session.clickStats).toEqual({ hit: 1, early: 1, off: 1, stray: 1 })
  })

  it('misses a circle clicked too early but close to its time, and only shakes one clicked much earlier', () => {
    const { session, events } = run(map, chart)
    expect(session.press(100, 100, 600)).toBeNull()
    expect(events).toHaveLength(0)
    session.press(100, 100, 800)
    expect(events.map((e) => [e.noteId, e.judgment])).toEqual([['a', 'miss']])
  })

  it('misses a circle nobody clicked once its window has passed', () => {
    const { session, events } = run(map, chart)
    session.update(1000 + DEFAULT_WINDOWS.missAfter + 1)
    expect(events.map((e) => e.judgment)).toEqual(['miss'])
  })

  it('completes a slider that is followed to the end and breaks one that is let go', () => {
    const notes = [hold(1, 1), tap(3)]
    const placed = placeCircles({ id: 'x', difficulty: 'normal', notes, timing: chartOf(notes).timing })
    const slider = placed.objects[0]
    expect(slider.kind).toBe('slider')

    const follow = run(placed, chartOf(notes))
    follow.session.press(slider.x, slider.y, 1000)
    for (let t = 1000; t <= slider.endTime * 1000 + 20; t += 16) {
      const ball = sliderBall(slider, t / 1000)
      follow.session.move(ball.x, ball.y)
      follow.session.update(t)
    }
    expect(follow.events.map((e) => e.judgment)).toEqual(['marvelous', 'marvelous'])

    const drop = run(placed, chartOf(notes))
    drop.session.press(slider.x, slider.y, 1000)
    drop.session.release(1100)
    for (let t = 1100; t <= 1500; t += 16) drop.session.update(t)
    expect(drop.events.map((e) => e.judgment)).toEqual(['marvelous', 'miss'])
    expect(drop.events[1].holdDrop).toBe(true)
  })

  it('auto-play clears a generated map with no misses', () => {
    const notes: ChartNote[] = []
    for (let i = 0; i < 200; i++) notes.push(i % 16 === 15 ? hold(i * 0.25, 0.5) : tap(i * 0.25, (i % 4) as Lane))
    const clean = notes.filter((n, i) => i === 0 || n.time >= (notes[i - 1].time + (notes[i - 1].duration ?? 0)))
    for (const difficulty of ['easy', 'normal', 'hard', 'expert'] as const) {
      const c = chartOf(clean, difficulty)
      const m = placeCircles(c)
      const events: HitEvent[] = []
      const session = new CircleSession({ chart: c, map: m, windows: DEFAULT_WINDOWS, autoPlay: true, onJudgment: (e) => events.push(e) })
      for (let t = 0; t < 60000 && !session.isFinished; t += 8) session.update(t)
      expect(events.filter((e) => e.judgment === 'miss')).toHaveLength(0)
      expect(session.scoreState.judged).toBe(m.objects.length + m.objects.filter((o) => o.kind === 'slider').length)
    }
  })

  it('a player who aims at each circle a little off time and position clears it', () => {
    const notes: ChartNote[] = []
    for (let i = 0; i < 160; i++) notes.push(i % 12 === 11 ? hold(i * 0.25, 0.5) : tap(i * 0.25, (i % 4) as Lane))
    const clean = notes.filter((n, i) => i === 0 || n.time >= notes[i - 1].time + (notes[i - 1].duration ?? 0))
    for (const difficulty of ['easy', 'hard', 'expert'] as const) {
      const c = chartOf(clean, difficulty)
      const m = placeCircles(c)
      const { session, events } = run(m, c)
      let next = 0
      for (let t = 0; t < 60000 && !session.isFinished; t += 4) {
        const target = m.objects[next]
        const active = session.activeSlider
        if (active) {
          const ball = sliderBall(active, t / 1000)
          session.move(ball.x + 10, ball.y - 10)
        }
        if (target && t >= target.time * 1000 + (next % 3) * 10 - 10) {
          if (!active) session.release(t)
          session.press(target.x + 12, target.y - 12, t)
          next++
        }
        session.update(t)
      }
      expect(events.filter((e) => e.judgment === 'miss')).toHaveLength(0)
    }
  })
})
