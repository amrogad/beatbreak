import { describe, expect, it } from 'vitest'
import { detectVoiceNotes, singerOnsets } from './voice'

const RATE = 44100

interface Sung {
  start: number
  duration: number
  midi: number
}

/** A rough sung line: a few harmonics, a soft attack and release, light vibrato. */
function sing(notes: Sung[], seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE
    const note = notes.find((n) => t >= n.start && t < n.start + n.duration)
    if (!note) continue
    const local = t - note.start
    const env = Math.min(1, local / 0.02) * Math.min(1, (note.start + note.duration - t) / 0.03)
    const hz = 440 * Math.pow(2, (note.midi - 69) / 12) * (1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t))
    phase += (2 * Math.PI * hz) / RATE
    let sample = 0
    for (let h = 1; h <= 6; h++) sample += Math.sin(phase * h) / h
    out[i] = 0.3 * env * sample
  }
  return out
}

describe('voice notes', () => {
  const line: Sung[] = [
    { start: 0.5, duration: 0.3, midi: 60 },
    { start: 0.8, duration: 0.3, midi: 64 },
    { start: 1.4, duration: 0.25, midi: 67 },
    { start: 1.72, duration: 0.25, midi: 67 },
    { start: 2.4, duration: 1.2, midi: 62 },
    { start: 4, duration: 0.2, midi: 71 },
  ]
  const notes = detectVoiceNotes(sing(line, 5), RATE)

  it('finds every sung note near its start', () => {
    expect(notes.length).toBe(line.length)
    for (const sung of line) {
      const found = notes.find((n) => Math.abs(n.time - sung.start) < 0.04)
      expect(found, `note at ${sung.start}`).toBeDefined()
      expect(Math.abs(found!.pitch - sung.midi)).toBeLessThan(0.5)
    }
  })

  it('keeps how long a note is held', () => {
    const held = notes.find((n) => Math.abs(n.time - 2.4) < 0.04)!
    expect(held.duration).toBeGreaterThan(1.05)
    expect(held.duration).toBeLessThan(1.3)
  })

  it('finds nothing in silence or noise', () => {
    const noise = new Float32Array(RATE * 2).map(() => (Math.random() - 0.5) * 0.02)
    expect(detectVoiceNotes(new Float32Array(RATE * 2), RATE)).toHaveLength(0)
    expect(detectVoiceNotes(noise, RATE).length).toBeLessThanOrEqual(1)
  })

  it('takes a nearby attack time and drops attacks with no singing', () => {
    const attacks = [
      { time: 0.49, strength: 0.8, band: 2, brightness: 0 },
      { time: 3.8, strength: 0.9, band: 3, brightness: 0.5 },
    ]
    const onsets = singerOnsets(attacks, notes)
    expect(onsets[0].time).toBeCloseTo(0.49, 3)
    expect(onsets.some((o) => Math.abs(o.time - 3.8) < 0.01)).toBe(false)
    expect(onsets.find((o) => Math.abs(o.time - 2.4) < 0.04)!.heldSeconds).toBeGreaterThan(1)
  })
})
