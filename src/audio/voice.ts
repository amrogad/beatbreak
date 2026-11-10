import type { OnsetEvent } from '../core/types'

/** A sung note found in an isolated vocal track. */
export interface VoiceNote {
  time: number
  duration: number
  /** Pitch as a MIDI note number (60 = middle C), the median over the note. */
  pitch: number
  /** Loudness against the song's loud singing, 0..1. */
  strength: number
}

const PITCH_RATE = 11025
const WINDOW = 512
const HOP = 64
const MIN_HZ = 75
const MAX_HZ = 1000
/** YIN threshold: below this the frame is clearly pitched. */
const VOICED_THRESHOLD = 0.2
/** Frames quieter than this many dB under the loud singing are not singing. */
const GATE_DB = 30
/** A pitch move this large (semitones) that holds starts a new note. */
const PITCH_STEP = 0.8
/** Shortest note kept, in seconds. */
const MIN_NOTE = 0.07
/** A dip this deep (dB) and back up inside one sung run is a new syllable on the same pitch. */
const REATTACK_DB = 5

function downsample(samples: Float32Array, rate: number): Float32Array {
  const ratio = rate / PITCH_RATE
  const out = new Float32Array(Math.floor(samples.length / ratio))
  const span = Math.max(1, Math.round(ratio))
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio)
    let sum = 0
    for (let k = 0; k < span && start + k < samples.length; k++) sum += samples[start + k]
    out[i] = sum / span
  }
  return out
}

/** YIN pitch per frame: Hz and how clearly pitched (lower = clearer), NaN when nothing fits. */
function yin(signal: Float32Array, frames: number): { hz: Float32Array; clarity: Float32Array; db: Float32Array } {
  const minLag = Math.floor(PITCH_RATE / MAX_HZ)
  const maxLag = Math.ceil(PITCH_RATE / MIN_HZ)
  const hz = new Float32Array(frames).fill(NaN)
  const clarity = new Float32Array(frames).fill(1)
  const db = new Float32Array(frames)
  const diff = new Float32Array(maxLag + 1)
  const size = WINDOW - maxLag
  for (let f = 0; f < frames; f++) {
    const start = f * HOP
    if (start + WINDOW > signal.length) break
    let energy = 0
    for (let i = 0; i < WINDOW; i++) energy += signal[start + i] * signal[start + i]
    db[f] = 10 * Math.log10(energy / WINDOW + 1e-12)
    let running = 0
    diff[0] = 1
    let best = -1
    for (let lag = 1; lag <= maxLag; lag++) {
      let sum = 0
      for (let i = 0; i < size; i++) {
        const d = signal[start + i] - signal[start + i + lag]
        sum += d * d
      }
      running += sum
      diff[lag] = running > 0 ? (sum * lag) / running : 1
      if (lag >= minLag + 1 && best < 0 && diff[lag - 1] < VOICED_THRESHOLD && diff[lag] > diff[lag - 1]) best = lag - 1
    }
    if (best < 0) {
      let min = Infinity
      for (let lag = minLag; lag <= maxLag; lag++) if (diff[lag] < min) { min = diff[lag]; best = lag }
    }
    const a = diff[best - 1] ?? diff[best]
    const b = diff[best]
    const c = diff[best + 1] ?? diff[best]
    const shift = a + c - 2 * b !== 0 ? (0.5 * (a - c)) / (a + c - 2 * b) : 0
    hz[f] = PITCH_RATE / (best + Math.max(-1, Math.min(1, shift)))
    clarity[f] = b
  }
  return { hz, clarity, db }
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/**
 * Sung notes from an isolated vocal track: where singing starts, where the pitch moves to a new
 * note, and where a new syllable re-attacks on the same pitch. Each note keeps its length, which
 * is what turns a held word into a long arrow.
 */
export function detectVoiceNotes(samples: Float32Array, sampleRate: number): VoiceNote[] {
  const signal = downsample(samples, sampleRate)
  const frames = Math.max(0, Math.floor((signal.length - WINDOW) / HOP) + 1)
  if (frames === 0) return []
  const { hz, clarity, db } = yin(signal, frames)
  const frameSeconds = HOP / PITCH_RATE
  // Frame times sit at the centre of the analysis window.
  const timeOf = (f: number): number => (f * HOP + WINDOW / 2) / PITCH_RATE

  const loud = [...db].filter((v) => v > -100).sort((a, b) => a - b)
  const reference = loud.length ? loud[Math.floor(loud.length * 0.95)] : 0
  const gate = reference - GATE_DB
  const midi = new Float32Array(frames).fill(NaN)
  for (let f = 0; f < frames; f++) {
    if (db[f] >= gate && clarity[f] < VOICED_THRESHOLD * 1.5 && hz[f] >= MIN_HZ && hz[f] <= MAX_HZ) {
      midi[f] = 69 + 12 * Math.log2(hz[f] / 440)
    }
  }
  // One stray frame never breaks or starts a run.
  for (let f = 1; f + 1 < frames; f++) {
    if (Number.isNaN(midi[f]) && !Number.isNaN(midi[f - 1]) && !Number.isNaN(midi[f + 1])) midi[f] = (midi[f - 1] + midi[f + 1]) / 2
    else if (!Number.isNaN(midi[f]) && Number.isNaN(midi[f - 1]) && Number.isNaN(midi[f + 1])) midi[f] = NaN
  }

  const minFrames = Math.ceil(MIN_NOTE / frameSeconds)
  const look = Math.max(3, Math.round(0.035 / frameSeconds))
  const notes: VoiceNote[] = []
  const push = (from: number, to: number): void => {
    if (to - from < minFrames) return
    const pitches: number[] = []
    let peak = -Infinity
    for (let f = from; f < to; f++) {
      if (!Number.isNaN(midi[f])) pitches.push(midi[f])
      if (db[f] > peak) peak = db[f]
    }
    if (pitches.length < minFrames / 2) return
    notes.push({
      time: timeOf(from),
      duration: (to - from) * frameSeconds,
      pitch: median(pitches),
      strength: Math.max(0, Math.min(1, 1 - (reference - peak) / GATE_DB)),
    })
  }

  let f = 0
  while (f < frames) {
    if (Number.isNaN(midi[f])) {
      f++
      continue
    }
    let end = f
    while (end < frames && !Number.isNaN(midi[end])) end++
    // Split the sung run where the pitch settles on a new note or the loudness dips and re-attacks.
    let start = f
    for (let k = f + look; k < end - look; k++) {
      const before: number[] = []
      const after: number[] = []
      for (let j = 1; j <= look; j++) {
        before.push(midi[k - j])
        after.push(midi[k + j - 1])
      }
      const moved = Math.abs(median(after) - median(before)) >= PITCH_STEP
      const steady = Math.max(...after) - Math.min(...after) < PITCH_STEP
      let dipped = false
      if (!moved && db[k] <= db[k - 1] && db[k] < db[k + 1]) {
        let left = -Infinity
        let right = -Infinity
        for (let j = 1; j <= look * 2; j++) {
          if (k - j >= start) left = Math.max(left, db[k - j])
          if (k + j < end) right = Math.max(right, db[k + j])
        }
        dipped = left - db[k] >= REATTACK_DB && right - db[k] >= REATTACK_DB
      }
      if ((moved && steady) || dipped) {
        if (k - start >= minFrames) {
          push(start, k)
          start = k
          k += minFrames
        }
      }
    }
    push(start, end)
    f = end
  }
  return notes
}

/** Sung notes as onsets the chart generator can read: a mid-band hit that rings for its length. */
export function voiceOnsets(notes: VoiceNote[]): OnsetEvent[] {
  return notes.map((note) => ({
    time: note.time,
    strength: note.strength,
    band: 2,
    brightness: 0,
    heldSeconds: note.duration,
  }))
}

/** How far before a sung note's voicing the attack that starts it may sit, and after. */
const ATTACK_BEFORE = 0.08
const ATTACK_AFTER = 0.04

/**
 * The singer's onsets: attacks heard in the vocal track that start or re-attack a sung note, plus
 * sung notes that glide in with no clear attack. Attack times are sharper than voicing times, so a
 * note takes its attack's time when one is close. Breaths, bleed and other noise in the vocal
 * track carry no pitch and are dropped.
 */
export function singerOnsets(stemOnsets: readonly OnsetEvent[], notes: readonly VoiceNote[]): OnsetEvent[] {
  const attacks = [...stemOnsets].sort((a, b) => a.time - b.time)
  const out: OnsetEvent[] = []
  let a = 0
  for (const note of notes) {
    while (a < attacks.length && attacks[a].time < note.time - ATTACK_BEFORE) a++
    let first: OnsetEvent | null = null
    const end = note.time + note.duration
    for (let k = a; k < attacks.length && attacks[k].time < end - 0.05; k++) {
      const attack = attacks[k]
      if (!first && attack.time <= note.time + ATTACK_AFTER) {
        first = attack
        continue
      }
      // A clear attack inside a held note is a new syllable.
      if (attack.time > note.time + ATTACK_AFTER && attack.strength >= 0.35) {
        out.push({ ...attack, band: 2, brightness: 0, heldSeconds: end - attack.time })
      }
    }
    const time = first ? first.time : note.time
    out.push({ time, strength: Math.max(note.strength, first?.strength ?? 0), band: 2, brightness: 0, heldSeconds: end - time })
  }
  out.sort((x, y) => x.time - y.time)
  // A re-attack splits the held note before it.
  for (let i = 0; i + 1 < out.length; i++) {
    const gap = out[i + 1].time - out[i].time
    if ((out[i].heldSeconds ?? 0) > gap) out[i].heldSeconds = Math.max(0.05, gap - 0.02)
  }
  return out.filter((onset, i) => i === 0 || onset.time - out[i - 1].time > 0.04)
}
