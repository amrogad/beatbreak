/**
 * Synthetic test rhythm.
 *
 * A drum machine rendered straight into a Float32Array with plain math — no Web Audio, no assets,
 * no copyrighted material. It exists so that the analysis pipeline, the chart generator and the
 * gameplay loop can be tested (and demoed) against a signal whose true BPM and beat positions are
 * known by construction.
 *
 * Structure: intro → main groove → breakdown → build → peak → outro, with a short silent lead-in so the
 * "first beat" position is a real, verifiable number.
 */
import { createRng } from '../core/rng'

export interface SynthOptions {
  bpm?: number
  sampleRate?: number
  bars?: number
  /** Silence before the first beat, in seconds. */
  leadInSeconds?: number
  seed?: number
  /** Add a melodic layer (extra onsets that are not drum hits). */
  melody?: boolean
}

export interface SynthResult {
  samples: Float32Array
  sampleRate: number
  bpm: number
  /** Seconds of audio at beat 0 (== leadInSeconds, by construction). */
  offset: number
  bars: number
  duration: number
  /** Ground-truth beat times, for tests. */
  beatTimes: number[]
}

/** Deterministic white noise. */
function makeNoise(seed: number): () => number {
  const rng = createRng(seed)
  return () => rng.range(-1, 1)
}

export function renderTestRhythm(options: SynthOptions = {}): SynthResult {
  const bpm = options.bpm ?? 128
  const sampleRate = options.sampleRate ?? 44100
  const bars = options.bars ?? 24
  const leadIn = options.leadInSeconds ?? 0.35
  const withMelody = options.melody ?? true
  const rng = createRng(options.seed ?? 0x7e57)
  const noise = makeNoise(options.seed ?? 0x7e57)

  const beatSeconds = 60 / bpm
  const tailSeconds = 2
  const duration = leadIn + bars * 4 * beatSeconds + tailSeconds
  const total = Math.ceil(duration * sampleRate)
  const samples = new Float32Array(total)

  const mix = (startSeconds: number, generator: (t: number, i: number) => number, lengthSeconds: number): void => {
    const start = Math.floor(startSeconds * sampleRate)
    const length = Math.floor(lengthSeconds * sampleRate)
    for (let i = 0; i < length; i++) {
      const index = start + i
      if (index < 0 || index >= total) continue
      samples[index] += generator(i / sampleRate, i)
    }
  }

  const kick = (amp = 0.95): ((t: number) => number) => (t) => {
    const pitch = 46 + 120 * Math.exp(-t * 26)
    const env = Math.exp(-t * 8.5)
    return Math.sin(2 * Math.PI * pitch * t) * env * amp
  }

  const snare = (amp = 0.6): ((t: number) => number) => (t) => {
    const env = Math.exp(-t * 24)
    const tone = Math.sin(2 * Math.PI * 190 * t) * 0.35
    return (noise() * 0.85 + tone) * env * amp
  }

  const hat = (amp = 0.22, decay = 46): ((t: number) => number) => {
    let previous = 0
    return (t) => {
      const raw = noise()
      // One-pole high pass so it reads as a hi-hat rather than broadband noise.
      const filtered = raw - previous
      previous = raw
      return filtered * Math.exp(-t * decay) * amp
    }
  }

  const crash = (amp = 0.4): ((t: number) => number) => {
    let previous = 0
    return (t) => {
      const raw = noise()
      const filtered = raw - previous * 0.6
      previous = raw
      return filtered * Math.exp(-t * 2.2) * amp
    }
  }

  const bass = (freq: number, amp = 0.4): ((t: number) => number) => (t) =>
    Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 5.5) * amp

  const lead = (freq: number, amp = 0.2): ((t: number) => number) => (t) =>
    (Math.sin(2 * Math.PI * freq * t) * 0.8 + Math.sin(4 * Math.PI * freq * t) * 0.2) *
    Math.exp(-t * 9) *
    amp

  // A held note with a soft attack and release, so the song has sustained sounds to hold.
  const sustained = (freq: number, lengthSeconds: number, amp: number, bright = 0.3): ((t: number) => number) => (t) => {
    const env = Math.min(1, t / 0.004) * (0.6 + 0.4 * Math.exp(-t * 14)) * Math.min(1, Math.max(0, (lengthSeconds - t) / 0.08))
    const vibrato = 1 + 0.004 * Math.sin(2 * Math.PI * 5 * t)
    const phase = 2 * Math.PI * freq * vibrato * t
    return (Math.sin(phase) * (1 - bright) + Math.sin(2 * phase) * bright * 0.6 + Math.sin(3 * phase) * bright * 0.4) * env * amp
  }

  // A minor, F, C, G: one chord per bar under the drums.
  const chords = [
    [220, 261.63, 329.63],
    [174.61, 220, 261.63],
    [261.63, 329.63, 392],
    [196, 246.94, 293.66],
  ]
  const roots = [55, 43.65, 65.41, 49]
  const scale = [220, 261.63, 293.66, 349.23, 392, 440, 523.25]
  const beatTime = (beat: number): number => leadIn + beat * beatSeconds

  for (let bar = 0; bar < bars; bar++) {
    const section = withMelody
      ? bar < 4 ? 'intro' : bar < 10 ? 'main' : bar < 14 ? 'breakdown' : bar < 16 ? 'build' : bar < 22 ? 'peak' : 'outro'
      : bar < 4 ? 'intro' : bar < 12 ? 'main' : bar < 16 ? 'build' : bar < 22 ? 'peak' : 'outro'
    const barStart = bar * 4

    if (section === 'peak' && bar === 16) mix(beatTime(barStart), crash(), 1.6)

    for (let beat = 0; beat < 4; beat++) {
      const position = barStart + beat
      // The breakdown drops the drums, so the melody's long notes ring out on their own.
      if (section === 'breakdown') continue
      if (section === 'intro') {
        if (beat % 2 === 0) mix(beatTime(position), kick(0.85), 0.4)
        mix(beatTime(position + 0.5), hat(0.16), 0.1)
      } else if (section === 'outro') {
        if (beat === 0) mix(beatTime(position), kick(0.8), 0.4)
        if (beat === 2) mix(beatTime(position), kick(0.6), 0.4)
      } else {
        if (section === 'peak' && beat % 2 === 1) mix(beatTime(position), kick(0.7), 0.35)
        else if (beat % 2 === 0) mix(beatTime(position), kick(), 0.45)
        if (beat % 2 === 1) mix(beatTime(position), snare(), 0.35)
        mix(beatTime(position), hat(section === 'build' ? 0.2 : 0.24), 0.12)
      }
      // Eighth-note hats, doubled to sixteenths in build/peak sections.
      mix(beatTime(position + 0.5), hat(section === 'peak' ? 0.22 : 0.17), 0.1)
      if (section === 'build' || section === 'peak') {
        if (section === 'peak' && rng.chance(0.55)) mix(beatTime(position + 0.25), hat(0.12, 60), 0.06)
        if (section === 'peak' && rng.chance(0.3)) mix(beatTime(position + 0.75), hat(0.11, 60), 0.06)
      }
      if (section !== 'intro' && section !== 'outro' && beat % 2 === 0) {
        mix(beatTime(position), bass(roots[bar % 4] * (beat === 2 ? 1.5 : 1)), 0.7)
      }
    }

    // A soft chord pad under every bar.
    const barSeconds = 4 * beatSeconds
    const padAmp = section === 'intro' || section === 'outro' ? 0.05 : 0.07
    if (withMelody) for (const freq of chords[bar % 4]) mix(beatTime(barStart), sustained(freq, barSeconds, padAmp, 0.1), barSeconds)

    // The main groove sings a phrase with long notes to hold, two bars at a time.
    if (withMelody && section === 'breakdown') {
      const phrase: [number, number, number][] = bar % 2 === 0
        ? [[0, 2, 4], [2, 2, 2]]
        : [[0, 1.5, 3], [2, 2, 0]]
      for (const [beat, beats, note] of phrase) {
        const seconds = beats * beatSeconds - 0.08
        mix(beatTime(barStart + beat), sustained(scale[note] * 4, seconds, 0.36, 0.5), seconds)
      }
    }

    if (withMelody && section === 'main') {
      const phrase: [number, number, number][] = bar % 2 === 0
        ? [[0.5, 1.5, 4], [2.5, 1.5, 2]]
        : [[0.5, 1, 0], [1.5, 0.5, 1], [2.5, 1.5, 4]]
      for (const [beat, beats, note] of phrase) {
        const freq = scale[(note + (bar % 4 === 3 ? 1 : 0)) % scale.length] * 4
        mix(beatTime(barStart + beat), sustained(freq, beats * beatSeconds * 0.95, 0.24), beats * beatSeconds)
      }
    }

    if (withMelody && (section === 'build' || section === 'peak')) {
      for (let eighth = 0; eighth < 8; eighth++) {
        const freq = scale[(bar + eighth) % scale.length]
        mix(beatTime(barStart + eighth * 0.5), lead(freq, section === 'peak' ? 0.18 : 0.14), 0.3)
      }
    }
  }

  // Normalize with a little headroom.
  let peak = 0
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(samples[i]))
  if (peak > 0) {
    const gain = 0.92 / peak
    for (let i = 0; i < total; i++) samples[i] *= gain
  }

  const beatTimes: number[] = []
  for (let beat = 0; beat < bars * 4; beat++) beatTimes.push(beatTime(beat))

  return { samples, sampleRate, bpm, offset: leadIn, bars, duration, beatTimes }
}

/** Encode mono Float32 samples as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number, channels = 1): ArrayBuffer {
  const bytesPerSample = 2
  const frameCount = channels === 1 ? samples.length : Math.floor(samples.length / channels)
  const dataSize = frameCount * channels * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  const total = frameCount * channels
  for (let i = 0; i < total; i++) {
    const sample = Math.max(-1, Math.min(1, i < samples.length ? samples[i] : 0))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += 2
  }
  return buffer
}

/** The demo's file name; the setup screen shows it as a generated track rather than a file. */
export const DEMO_FILE_NAME = 'Demo Track.wav'

/** Browser helper: wrap the synthetic rhythm in a File so it flows through the normal import path. */
export function createTestSongFile(options: SynthOptions = {}): { file: File; truth: SynthResult } {
  const truth = renderTestRhythm(options)
  const wav = encodeWav(truth.samples, truth.sampleRate, 1)
  const fileName = DEMO_FILE_NAME
  const file = new File([wav], fileName, { type: 'audio/wav', lastModified: Date.now() })
  return { file, truth }
}
