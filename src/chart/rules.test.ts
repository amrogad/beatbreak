import { describe, expect, it } from 'vitest'
import type { ChartNote, Lane } from '../core/types'
import { applyChartRules } from './rules'
import { TimingMap } from './timing'

const timing = TimingMap.single(120, 0) // one beat = 0.5 s
const tap = (time: number, lane: Lane, strength = 0.8): ChartNote => ({
  id: `t${time}-${lane}`,
  lane,
  time,
  beat: time * 2,
  step: Math.round(time * 8),
  kind: 'tap',
  strength,
})
const hold = (time: number, lane: Lane, duration: number): ChartNote => ({ ...tap(time, lane, 1), id: `h${time}-${lane}`, kind: 'hold', duration })
const settings = { stepsPerBeat: 4, maxChord: 2, minJackGap: 0.11 }

describe('chart rules', () => {
  it('turns arrows that are almost together into a chord', () => {
    const out = applyChartRules([tap(1, 0, 0.9), tap(1.04, 2)], timing, settings, 'hard')
    expect(out.map((n) => n.time)).toEqual([1, 1])
  })

  it('drops the weaker arrow when a chord would break the limit', () => {
    const out = applyChartRules([tap(1, 0, 0.9), tap(1.04, 2, 0.5)], timing, { ...settings, maxChord: 1 }, 'hard')
    expect(out).toHaveLength(1)
    expect(out[0].lane).toBe(0)
  })

  it('never leaves more than 12 arrows in any one second', () => {
    // 16ths at 200 BPM: 13.3 a second, with every downbeat a two-arrow chord.
    const fast = TimingMap.single(200, 0)
    const step = 60 / 200 / 4
    const notes: ChartNote[] = []
    for (let i = 0; i < 80; i++) {
      notes.push({ ...tap(i * step, (i % 4) as Lane, i % 4 === 0 ? 0.9 : 0.5), beat: i / 4, step: i })
      if (i % 4 === 0) notes.push({ ...tap(i * step, ((i + 2) % 4) as Lane, 0.6), id: `c${i}`, beat: i / 4, step: i })
    }
    const out = applyChartRules(notes, fast, { stepsPerBeat: 4, maxChord: 2, minJackGap: 0.05 }, 'expert')
    for (let i = 0; i < out.length; i++) {
      const inSecond = out.filter((n) => n.time >= out[i].time && n.time - out[i].time <= 1).length
      expect(inSecond).toBeLessThanOrEqual(12)
    }
  })

  it('keeps arrows a full grid step apart', () => {
    const out = applyChartRules([tap(1, 0), tap(1.125, 2)], timing, settings, 'expert')
    expect(out.map((n) => n.time)).toEqual([1, 1.125])
  })

  it('clears other columns during a hold on Easy and Normal, except at its start and end', () => {
    const notes = [hold(1, 0, 1), tap(1, 1), tap(1.5, 2), tap(2, 3)]
    const out = applyChartRules(notes, timing, { stepsPerBeat: 2, maxChord: 2, minJackGap: 0.28 }, 'normal')
    expect(out.map((n) => n.time)).toEqual([1, 1, 2])
  })

  it('ends two close releases together', () => {
    const notes = [hold(1, 0, 1), hold(1.25, 2, 0.85)]
    const out = applyChartRules(notes, timing, settings, 'hard')
    const ends = out.filter((n) => n.kind === 'hold').map((n) => +(n.time + n.duration!).toFixed(3))
    expect(new Set(ends).size).toBe(1)
  })

  it('drops a lone arrow two bars or more before the chart starts', () => {
    const notes = [hold(0.5, 2, 1.5), ...[5, 5.5, 6, 6.5].map((t, i) => tap(t, (i % 4) as Lane))]
    const out = applyChartRules(notes, timing, settings, 'hard')
    expect(out.map((n) => n.time)).toEqual([5, 5.5, 6, 6.5])
  })

  it('drops a lone arrow two bars or more after the chart ends', () => {
    const notes = [...[1, 1.5, 2, 2.5].map((t, i) => tap(t, (i % 4) as Lane)), tap(7, 1)]
    const out = applyChartRules(notes, timing, settings, 'hard')
    expect(out.map((n) => n.time)).toEqual([1, 1.5, 2, 2.5])
  })

  it('keeps an opening arrow that leads into the chart', () => {
    const notes = [tap(1, 0), ...[3, 3.5, 4].map((t, i) => tap(t, (i + 1) as Lane))]
    expect(applyChartRules(notes, timing, settings, 'hard')).toHaveLength(4)
  })

  it('turns holds shorter than the minimum into taps', () => {
    const out = applyChartRules([hold(1, 0, 0.3)], timing, { stepsPerBeat: 1, maxChord: 1, minJackGap: 0.4 }, 'easy')
    expect(out[0].kind).toBe('tap')
  })
})
