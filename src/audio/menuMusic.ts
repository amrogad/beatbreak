/**
 * Background music for the menus, like StepMania's song select: a looping preview of a song,
 * faded in and out, played through the shared AudioContext.
 *
 * One preview plays at a time. Asking for the same track again is a no-op, so screens can call
 * `play` on every render without restarting it.
 */
import { getAudioContext } from './engine'

const PREVIEW_SECONDS = 24
const FADE_SECONDS = 1.2
const MENU_GAIN = 0.4

interface Playing {
  key: string
  source: AudioBufferSourceNode
  gain: GainNode
}

let current: Playing | null = null
let volume = 1
let enabled = true

export function configureMenuMusic(options: { enabled: boolean; volume: number }): void {
  enabled = options.enabled
  volume = Math.max(0, Math.min(1, options.volume))
  if (!enabled) {
    stopMenuMusic()
    return
  }
  if (current) current.gain.gain.setTargetAtTime(MENU_GAIN * volume, getAudioContext().currentTime, 0.1)
}

/** Loop `buffer` from `startSeconds` for a short preview window. */
export function playMenuMusic(key: string, buffer: AudioBuffer, startSeconds: number, wholeTrack = false): void {
  if (!enabled) return
  if (current?.key === key) return
  const start = Math.max(0, Math.min(startSeconds, Math.max(0, buffer.duration - 4)))
  startLoop(key, buffer, start, wholeTrack ? buffer.duration : Math.min(buffer.duration, start + PREVIEW_SECONDS))
}

/** Loop a highlighted part so the player can hear what they picked, even with menu music off. */
export function playSelection(buffer: AudioBuffer, start: number, end: number): void {
  startLoop(`selection-${start}-${end}`, buffer, start, end)
}

function startLoop(key: string, buffer: AudioBuffer, start: number, end: number): void {
  stopMenuMusic()
  const ctx = getAudioContext()
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.loop = true
  source.loopStart = start
  source.loopEnd = end
  const gain = ctx.createGain()
  const now = ctx.currentTime
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(MENU_GAIN * volume, now + FADE_SECONDS)
  source.connect(gain).connect(ctx.destination)
  source.start(now, start)
  current = { key, source, gain }
}

export function stopMenuMusic(fadeSeconds = 0.5): void {
  const playing = current
  if (!playing) return
  current = null
  const ctx = getAudioContext()
  const now = ctx.currentTime
  playing.gain.gain.cancelScheduledValues(now)
  playing.gain.gain.setValueAtTime(playing.gain.gain.value, now)
  playing.gain.gain.linearRampToValueAtTime(0, now + fadeSeconds)
  try {
    playing.source.stop(now + fadeSeconds + 0.05)
  } catch {
    // Already stopped.
  }
}

/** Where a preview should start: the most energetic part of the song, or a third of the way in. */
export function previewStart(duration: number, sections: { start: number; energy: number }[] = []): number {
  const loudest = [...sections].sort((a, b) => b.energy - a.energy)[0]
  if (loudest && loudest.start > 0) return loudest.start
  return duration / 3
}
