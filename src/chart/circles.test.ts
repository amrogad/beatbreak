import { describe, expect, it } from 'vitest'
import type { ChartNote, Difficulty, Lane } from '../core/types'
import { DIFFICULTIES } from '../core/types'
import { FIELD_H, FIELD_W, circleRhythm, placeCircles, sliderBall, sliderExit } from './circles'

// 120 BPM: one beat = 0.5 s.
const timing = { offset: 0, bpms: [{ beat: 0, bpm: 120 }] }
const tap = (time: number, lane: Lane, strength = 0.7): ChartNote => ({
  id: `t${time}-${lane}`,
  lane,
  time,
  beat: time * 2,
  step: Math.round(time * 8),
  kind: 'tap',
  strength,
})
const hold = (time: number, lane: Lane, duration: number): ChartNote => ({ ...tap(time, lane, 1), id: `h${time}-${lane}`, kind: 'hold', duration })

/** A song-like chart: a repeating 2-bar riff with eighths, quarters, a few holds and a fast burst. */
function song(): ChartNote[] {
  const notes: ChartNote[] = []
  for (let bar = 0; bar < 48; bar++) {
    const t0 = bar * 2
    const riff = bar % 2 === 0 ? [0, 0.5, 0.75, 1, 1.5] : [0, 0.25, 0.5, 1, 1.25, 1.5, 1.625, 1.75]
    riff.forEach((t, i) => notes.push(tap(t0 + t, ((bar + i) % 4) as Lane, i === 0 ? 1 : 0.5 + (i % 3) * 0.15)))
    if (bar % 8 === 7) notes.push(hold(t0 + 1.875, 2, 0.5))
  }
  return notes.sort((a, b) => a.time - b.time)
}

const place = (difficulty: Difficulty, notes = song()) => placeCircles({ id: `test-${difficulty}`, difficulty, notes, timing })

describe('circle placement', () => {
  it('takes each difficulty rhythm from the arrow chart one step easier', () => {
    const charts = DIFFICULTIES.map((difficulty) => ({ difficulty }))
    expect(DIFFICULTIES.map((d) => circleRhythm(charts, charts.find((c) => c.difficulty === d)!).difficulty)).toEqual(['easy', 'easy', 'normal', 'hard'])
    expect(circleRhythm([{ difficulty: 'hard' as Difficulty }], { difficulty: 'hard' as Difficulty }).difficulty).toBe('hard')
  })

  it('keeps a beat between easy circles', () => {
    const map = place('easy')
    for (let i = 1; i < map.objects.length; i++) {
      expect((map.objects[i].time - map.objects[i - 1].endTime) * 2).toBeGreaterThanOrEqual(0.98)
    }
  })

  it('keeps every circle and slider path inside the field', () => {
    for (const difficulty of DIFFICULTIES) {
      const map = place(difficulty)
      for (const o of map.objects) {
        for (const p of [o, ...(o.path ?? [])]) {
          expect(p.x).toBeGreaterThanOrEqual(0)
          expect(p.x).toBeLessThanOrEqual(FIELD_W)
          expect(p.y).toBeGreaterThanOrEqual(0)
          expect(p.y).toBeLessThanOrEqual(FIELD_H)
        }
      }
    }
  })

  it('places the same chart the same way every time', () => {
    expect(place('hard')).toEqual(place('hard'))
  })

  it('keeps the rhythm: one object per moment, at the arrow times', () => {
    const notes = [tap(1, 0), tap(1, 2), tap(1.5, 1), tap(2, 3)]
    const map = place('expert', notes)
    expect(map.objects.map((o) => o.time)).toEqual([1, 1.5, 2])
  })

  it('never lets a slider run into the next circle', () => {
    for (const difficulty of DIFFICULTIES) {
      const objects = place(difficulty).objects
      for (let i = 0; i < objects.length - 1; i++) {
        expect(objects[i].endTime).toBeLessThan(objects[i + 1].time)
      }
    }
  })

  it('never covers a circle that was on screen a beat before (Easy and Normal)', () => {
    for (const difficulty of ['easy', 'normal'] as const) {
      const map = place(difficulty)
      const objs = map.objects
      let covered = 0
      for (let i = 2; i < objs.length; i++) {
        for (let k = i - 2; k >= 0 && objs[i].time - objs[k].endTime <= 0.5; k--) {
          const exit = sliderExit(objs[k])
          if (Math.hypot(objs[i].x - exit.x, objs[i].y - exit.y) < map.radius) covered++
        }
      }
      expect(covered).toBe(0)
    }
  })

  it('spaces longer gaps further apart', () => {
    const map = place('normal')
    const byGap = new Map<number, number[]>()
    for (let i = 1; i < map.objects.length; i++) {
      const a = map.objects[i - 1]
      const b = map.objects[i]
      if (a.kind === 'slider') continue
      const gap = Math.round((b.time - a.time) * 8) / 4
      const list = byGap.get(gap) ?? []
      list.push(Math.hypot(b.x - a.x, b.y - a.y))
      byGap.set(gap, list)
    }
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[xs.length >> 1]
    expect(median(byGap.get(1)!)).toBeGreaterThan(median(byGap.get(0.5)!))
  })

  it('turns holds into sliders whose ball ends where the slider exits', () => {
    const map = place('normal', [tap(0, 0), hold(1, 1, 1), tap(3, 2)])
    const slider = map.objects.find((o) => o.kind === 'slider')!
    expect(slider).toBeDefined()
    const end = sliderBall(slider, slider.endTime)
    const exit = sliderExit(slider)
    expect(Math.hypot(end.x - exit.x, end.y - exit.y)).toBeLessThan(1)
  })

  it('starts a new combo with a new colour', () => {
    const objs = place('hard').objects
    const starts = objs.filter((o) => o.number === 1)
    expect(starts.length).toBeGreaterThan(5)
    for (let i = 1; i < objs.length; i++) {
      if (objs[i].number === 1) expect(objs[i].color).not.toBe(objs[i - 1].color)
      else expect(objs[i].number).toBe(objs[i - 1].number + 1)
    }
  })

  it('places a long chart quickly', () => {
    const notes: ChartNote[] = []
    for (let i = 0; i < 3000; i++) notes.push(tap(i * 0.125, (i % 4) as Lane, 0.4 + (i % 5) * 0.12))
    const started = performance.now()
    place('expert', notes)
    expect(performance.now() - started).toBeLessThan(400)
  })
})
