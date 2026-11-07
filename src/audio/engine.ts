/**
 * Audio engine: decoding, playback and the authoritative clock.
 *
 * Synchronization rules that this file exists to enforce:
 *  - Song position is always derived from `AudioContext.currentTime`, never from
 *    `requestAnimationFrame` or `setTimeout`. Dropped frames therefore cannot desynchronize
 *    hit detection; they only affect what is drawn.
 *  - Pausing stops the audio source (so nothing plays in the background) and records the exact
 *    song position; resuming schedules a fresh source at that position with a short lookahead so
 *    there is no gap or double-trigger.
 *  - Every node the engine creates is disconnected on dispose, and every scheduled source is
 *    stopped, so switching songs or leaving gameplay cannot leave audio running.
 */
import { buildEditPlan, toPlaybackPlan, type PlaybackPlan } from '../core/edit'
import { PlanClock, SmoothClock, planTimeForSongTime, snapIntoPlayback, type ScheduledSegment } from './planClock'

/** One smoothed clock per context, so what it learns about the device carries over between runs. */
const smoothClocks = new WeakMap<BaseAudioContext, SmoothClock>()

export interface AudioEngineOptions {
  /** Master volume 0..1. */
  volume?: number
  /** Player-calibrated output offset in milliseconds (positive = audio is late). */
  offsetMs?: number
  onEnded?: () => void
}

/** Decode failures mapped to messages a player can act on. */
export type DecodeErrorCode = 'unsupported' | 'corrupted' | 'too-large' | 'empty' | 'no-context'

export class DecodeError extends Error {
  readonly code: DecodeErrorCode
  constructor(code: DecodeErrorCode, message: string) {
    super(message)
    this.name = 'DecodeError'
    this.code = code
  }
}

let sharedContext: AudioContext | null = null

/** The app uses a single AudioContext: browsers limit how many can exist, and one clock is better. */
export function getAudioContext(): AudioContext {
  if (typeof window === 'undefined') throw new DecodeError('no-context', 'Web Audio is unavailable in this environment.')
  if (!sharedContext) {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) {
      throw new DecodeError('no-context', 'This browser does not support the Web Audio API.')
    }
    sharedContext = new Ctor({ latencyHint: 'interactive' })
  }
  return sharedContext
}

/**
 * Wake the shared context. iOS also leaves it 'interrupted' after a call, Siri or the lock screen,
 * and a refused resume can hang, so this never waits more than a couple of seconds.
 */
export async function resumeAudioContext(): Promise<void> {
  const ctx = getAudioContext()
  if (ctx.state === 'running' || ctx.state === 'closed') return
  await Promise.race([ctx.resume().catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 2500))])
}

/** Every song is decoded at this rate, whatever the device's output rate. */
export const ANALYSIS_RATE = 44100

let decoder: BaseAudioContext | null = null
/**
 * Decode at one fixed rate on every device. The analysis windows were tuned at 44.1 kHz; decoding at
 * a phone's or PC's 48 kHz moved the detected beat line by up to ~11 ms on real songs (measured),
 * so the same song charted differently per device. Playback resamples on its own.
 */
function decodingContext(): BaseAudioContext {
  if (decoder) return decoder
  const Offline: typeof OfflineAudioContext | undefined =
    typeof window !== 'undefined'
      ? (window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext)
      : undefined
  try {
    if (Offline) decoder = new Offline(2, 1, ANALYSIS_RATE)
  } catch {
    decoder = null
  }
  return decoder ?? getAudioContext()
}

/**
 * Longest song Beatbreak takes. The analysis holds the whole spectrum (about 21 MB a minute at
 * 44.1 kHz) next to the decoded song, so phones, which kill tabs far sooner, get a lower limit.
 */
export const MAX_SONG_SECONDS =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches ? 12 * 60 : 20 * 60

function tooLong(file: File, seconds: number): DecodeError {
  return new DecodeError(
    'too-large',
    `"${file.name}" is ${Math.round(seconds / 60)} minutes long. Beatbreak takes songs up to ${MAX_SONG_SECONDS / 60} minutes - ` +
      'cut out the part you want to play with any audio editor first.',
  )
}

/** The file's length from its header via a media element, or NaN when the browser cannot tell quickly. */
function probeDuration(file: File): Promise<number> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return Promise.resolve(NaN)
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const media = document.createElement('audio')
    let settled = false
    const done = (value: number): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      media.removeAttribute('src')
      media.load()
      URL.revokeObjectURL(url)
      resolve(value)
    }
    const timer = window.setTimeout(() => done(NaN), 3000)
    media.preload = 'metadata'
    media.onloadedmetadata = () => done(Number.isFinite(media.duration) ? media.duration : NaN)
    media.onerror = () => done(NaN)
    media.src = url
  })
}

/**
 * Decode an audio file into an AudioBuffer.
 *
 * Guardrails: file size (decoding expands to 32-bit float, ~10× the compressed size, and 4 bytes
 * per sample per channel in memory) and a Chromium-specific "empty decode" behaviour where
 * `decodeAudioData` can resolve with a zero-length buffer instead of rejecting.
 */
export async function decodeAudioFile(file: File, options: { maxBytes?: number } = {}): Promise<AudioBuffer> {
  const maxBytes = options.maxBytes ?? 320 * 1024 * 1024
  if (file.size === 0) {
    throw new DecodeError('empty', `"${file.name}" is empty (0 bytes).`)
  }
  if (file.size > maxBytes) {
    throw new DecodeError(
      'too-large',
      `"${file.name}" is ${(file.size / 1048576).toFixed(0)} MB. Files above ${(maxBytes / 1048576).toFixed(0)} MB ` +
        'usually need more memory than a browser tab can spare — try a shorter edit or a lower bitrate version.',
    )
  }
  // Size says little: an hour-long mp3 is 58 MB but decodes to 1.4 GB. Ask the browser for the
  // length first (it reads only the header), and refuse before the decode can take the tab down.
  const seconds = await probeDuration(file)
  if (seconds > MAX_SONG_SECONDS) throw tooLong(file, seconds)
  const arrayBuffer = await file.arrayBuffer()
  try {
    const buffer = await decodingContext().decodeAudioData(arrayBuffer)
    if (buffer && buffer.duration > MAX_SONG_SECONDS) throw tooLong(file, buffer.duration)
    if (!buffer || buffer.duration <= 0 || buffer.length === 0) {
      throw new DecodeError(
        'corrupted',
        `"${file.name}" decoded to an empty stream — the file is probably truncated or uses a codec this browser does not implement.`,
      )
    }
    return buffer
  } catch (error) {
    if (error instanceof DecodeError) throw error
    const type = (file.type || 'unknown type').toLowerCase()
    const looksLikeVideo = /mp4|webm|mpeg|video/.test(type) || /\.(mp4|mkv|avi|mov|webm)$/i.test(file.name)
    if (looksLikeVideo) {
      throw new DecodeError(
        'unsupported',
        `"${file.name}" looks like a video container. Export its audio track as MP3, WAV, OGG, M4A or FLAC first.`,
      )
    }
    throw new DecodeError(
      'corrupted',
      `Could not decode "${file.name}". The file may be corrupted, DRM-protected, or in a format this browser ` +
        'cannot decode (WAV, MP3, OGG, M4A/AAC and FLAC usually work).',
    )
  }
}

/** True when the browser reports it can probably play the given MIME type. */
export function isProbablySupportedAudio(file: File): boolean {
  if (!file.type) return true
  if (file.type.startsWith('audio/')) return true
  return false
}

export interface EngineSnapshot {
  songTime: number
  duration: number
  playing: boolean
  ended: boolean
}

/**
 * Best estimate of how long the audio takes to reach the speakers, in seconds (clamped to a
 * sane range). `outputLatency` is the first choice, but several Windows browsers report 0 while
 * the device still buffers 50–200 ms. `getOutputTimestamp()` exposes the output device's own
 * clock, so when the two disagree the larger plausible value wins. Devices with Bluetooth output
 * can be far off either way — that is what the tap calibration is for.
 *
 * Sample this once per playback (see `AudioEngine.play`): a latency that jitters mid-song would
 * swing every other hit early and late.
 */
export function estimateOutputLatency(ctx: AudioContext): number {
  const media = ctx as AudioContext & {
    outputLatency?: number
    getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number }
  }
  let latency =
    typeof media.outputLatency === 'number' && Number.isFinite(media.outputLatency) ? media.outputLatency : 0
  if (typeof media.getOutputTimestamp === 'function') {
    try {
      const stamp = media.getOutputTimestamp()
      const contextTime = stamp?.contextTime
      const performanceTime = stamp?.performanceTime
      if (
        typeof contextTime === 'number' &&
        typeof performanceTime === 'number' &&
        Number.isFinite(contextTime) &&
        Number.isFinite(performanceTime) &&
        contextTime > 0 &&
        performanceTime > 0
      ) {
        // Where the device is actually playing right now, in context time.
        const audibleNow = contextTime + (performance.now() - performanceTime) / 1000
        const estimate = ctx.currentTime - audibleNow
        if (Number.isFinite(estimate)) latency = Math.max(latency, estimate)
      }
    } catch {
      // Not available or not running yet: outputLatency (or 0) remains the estimate.
    }
  }
  return Math.max(0, Math.min(latency, 0.4))
}

export class AudioEngine {
  private ctx: AudioContext
  private buffer: AudioBuffer
  private gain: GainNode
  /** Everything scheduled for the current playback: parts are spliced, so there can be several. */
  private scheduled: { source: AudioBufferSourceNode; gain: GainNode }[] = []
  private clock = new PlanClock()
  /** Plan currently being played (set by `play`); null before the first call. */
  private plan: PlaybackPlan | null = null
  private pausedAt = 0
  private playing = false
  private ended = false
  private disposed = false
  private volume: number
  private offsetMs: number
  /** Output latency estimate, sampled once per `play` so judged timing cannot jitter. */
  private latencySeconds = 0
  /** Judge time at the moment playback was asked to start (see `judgeTime`). */
  private judgeFloor = -Infinity
  private onEnded?: () => void
  private endCheckTimer: ReturnType<typeof setTimeout> | null = null
  private smooth: SmoothClock

  constructor(ctx: AudioContext, buffer: AudioBuffer, options: AudioEngineOptions = {}) {
    this.ctx = ctx
    let smooth = smoothClocks.get(ctx)
    if (!smooth) smoothClocks.set(ctx, (smooth = new SmoothClock()))
    this.smooth = smooth
    this.buffer = buffer
    this.volume = options.volume ?? 0.9
    this.offsetMs = options.offsetMs ?? 0
    this.onEnded = options.onEnded
    this.gain = ctx.createGain()
    this.gain.gain.value = this.volume
    this.gain.connect(ctx.destination)
  }

  get duration(): number {
    return this.buffer.duration
  }

  /** Length of the edited timeline (window minus cuts) in seconds. */
  get planDuration(): number {
    return this.plan ? this.plan.duration : this.buffer.duration
  }

  /** Position in the edited timeline in seconds — continuous, so it drives the progress bar. */
  get planTime(): number {
    if (this.disposed) return 0
    if (!this.playing || !this.plan) return this.plan ? planTimeForSongTime(this.plan, this.pausedAt) : this.pausedAt
    return this.clock.planTimeAt(this.now())
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get hasEnded(): boolean {
    return this.ended
  }

  /**
   * The moment of the song the player is *hearing* right now, in seconds of the original audio.
   * Across a cut the clock jumps from the end of the removed interval to the note after it, which
   * is exactly what the player hears. `outputLatency` is subtracted when the browser reports it,
   * because the sound leaves the speakers that much later than the audio graph produces it.
   */
  get songTime(): number {
    if (this.disposed) return 0
    if (!this.playing) return this.pausedAt
    return this.clock.songTimeAt(this.now())
  }

  /** The audio clock without its buffer-sized steps (see `SmoothClock`): judging and drawing read this. */
  private now(): number {
    return this.smooth.read(this.ctx.currentTime, performance.now())
  }

  /**
   * Song time used for judgement: what the player hears, minus their calibration offset. The
   * shift is applied on the audio clock before mapping to the song, so across a cut the judge
   * clock jumps when the player hears the join, not when the graph renders it. After the audio
   * has ended it keeps running, so the last notes and hold tails are still judged.
   */
  get judgeTime(): number {
    if (this.disposed) return 0
    const shift = this.outputLatency + this.offsetMs / 1000
    // During the scheduling lookahead nothing sounds yet: hold at the start instead of stepping back.
    if (this.playing || this.ended) return Math.max(this.judgeFloor, this.clock.songTimeAtUnclamped(this.now() - shift))
    return this.pausedAt - shift
  }

  /** Device output latency, sampled when playback starts so it cannot jitter mid-run. */
  get outputLatency(): number {
    return this.latencySeconds
  }

  get outputOffsetMs(): number {
    return this.offsetMs
  }

  setOutputOffsetMs(offsetMs: number): void {
    this.offsetMs = offsetMs
  }

  /**
   * Start (or restart) playback.
   *
   * Two ways to call it:
   *  - `play(from, until)` plays the window `[from, until]` of the original audio straight
   *    through (used by simple previews and the editor).
   *  - `play(from, _, plan)` plays a `PlaybackPlan`: the kept segments of a trimmed song are
   *    scheduled back-to-back with 5 ms micro-fades at the splices, so a cut sounds like the music
   *    continues after the removed part instead of skipping.
   *
   * The clock (`songTime`) reports *original-audio* positions and jumps over cuts; `planTime`
   * counts only played audio and never jumps.
   */
  play(fromSeconds = 0, untilSeconds?: number, plan?: PlaybackPlan): void {
    if (this.disposed) return
    this.stopSources()
    this.latencySeconds = estimateOutputLatency(this.ctx)
    const duration = this.buffer.duration
    const playback =
      plan ?? toPlaybackPlan(buildEditPlan({ start: fromSeconds, end: untilSeconds ?? duration }, [], duration))
    if (playback.segments.length === 0) return
    this.plan = playback
    const start = snapIntoPlayback(playback, fromSeconds)
    this.judgeFloor = start - this.latencySeconds - this.offsetMs / 1000
    // A short lookahead keeps the scheduling jitter of the main thread out of the audio path.
    const when = this.ctx.currentTime + 0.03
    const startPb = planTimeForSongTime(playback, start)
    const scheduledSegments: ScheduledSegment[] = []
    const lastIndex = playback.segments.length - 1
    const fade = 0.005
    for (let i = 0; i < playback.segments.length; i++) {
      const segment = playback.segments[i]
      if (segment.origEnd <= start + 1e-6) continue
      const offset = Math.max(start, segment.origStart)
      const length = segment.origEnd - offset
      if (length <= 1e-6) continue
      const pbStart = segment.pbStart + (offset - segment.origStart)
      const startAt = when + Math.max(0, pbStart - startPb)
      const source = this.ctx.createBufferSource()
      source.buffer = this.buffer
      source.playbackRate.value = 1
      const segmentGain = this.ctx.createGain()
      // Micro-fades wherever the music can start or stop mid-wave: every segment start (a splice,
      // a resume, a trimmed start) and every end except the real end of the file.
      segmentGain.gain.setValueAtTime(0.0001, startAt)
      segmentGain.gain.linearRampToValueAtTime(1, startAt + fade)
      if (i !== lastIndex || offset + length < duration - 1e-3) {
        segmentGain.gain.setValueAtTime(1, startAt + Math.max(0, length - fade))
        segmentGain.gain.linearRampToValueAtTime(0.0001, startAt + length)
      }
      source.connect(segmentGain)
      segmentGain.connect(this.gain)
      source.start(startAt, offset, length)
      scheduledSegments.push({
        pbStart,
        pbEnd: pbStart + length,
        origStart: offset,
        origEnd: offset + length,
        ctxStart: startAt,
        ctxEnd: startAt + length,
      })
      this.scheduled.push({ source, gain: segmentGain })
    }
    this.clock.schedule(scheduledSegments, start)
    const lastEntry = this.scheduled[this.scheduled.length - 1]
    if (lastEntry) {
      lastEntry.source.onended = () => {
        if (this.disposed || !this.playing || this.ended) return
        if (this.clock.finishedAt(this.ctx.currentTime)) this.finish()
      }
    }
    this.playing = true
    this.ended = false
    this.pausedAt = start
    this.scheduleEndCheck()
  }

  pause(): void {
    if (this.disposed || !this.playing) return
    const position = this.songTime
    this.stopSources()
    this.playing = false
    this.pausedAt = position
  }

  resume(): void {
    if (this.disposed || this.playing) return
    this.play(this.pausedAt, undefined, this.plan ?? undefined)
  }

  seek(seconds: number): void {
    if (this.disposed) return
    if (this.playing) {
      this.play(seconds, undefined, this.plan ?? undefined)
      return
    }
    const target = this.plan
      ? snapIntoPlayback(this.plan, Math.max(0, Math.min(seconds, this.buffer.duration)))
      : Math.max(0, Math.min(seconds, this.buffer.duration))
    this.pausedAt = target
    const last = this.plan && this.plan.segments.length > 0 ? this.plan.segments[this.plan.segments.length - 1] : null
    this.ended = last ? target >= last.origEnd - 0.01 : false
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    if (!this.disposed) {
      // Short ramp avoids clicks when the player drags the slider.
      const now = this.ctx.currentTime
      this.gain.gain.cancelScheduledValues(now)
      this.gain.gain.setValueAtTime(this.gain.gain.value, now)
      this.gain.gain.linearRampToValueAtTime(this.volume, now + 0.05)
    }
  }

  /**
   * Fade the master gain to silence over `seconds`. Gameplay uses this when the run is complete
   * so the song ends musically instead of being cut off the instant the last arrow is judged.
   */
  fadeOut(seconds = 1): void {
    if (this.disposed) return
    const now = this.ctx.currentTime
    const gain = this.gain.gain
    gain.cancelScheduledValues(now)
    gain.setValueAtTime(Math.max(0.0001, gain.value), now)
    gain.linearRampToValueAtTime(0.0001, now + Math.max(0.05, seconds))
  }

  /** Metronome click scheduled at an exact song time (used by the editor preview). */
  scheduleClickAt(songTimeSeconds: number, accent = false): void {
    if (this.disposed) return
    const ctx = this.ctx
    const delay = Math.max(0, songTimeSeconds - this.songTime)
    const at = ctx.currentTime + delay
    const oscillator = ctx.createOscillator()
    const envelope = ctx.createGain()
    oscillator.type = 'square'
    oscillator.frequency.value = accent ? 1600 : 1050
    envelope.gain.setValueAtTime(0.0001, at)
    envelope.gain.exponentialRampToValueAtTime(accent ? 0.14 : 0.08, at + 0.004)
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.05)
    oscillator.connect(envelope)
    envelope.connect(this.gain)
    oscillator.start(at)
    oscillator.stop(at + 0.07)
    oscillator.onended = () => {
      oscillator.disconnect()
      envelope.disconnect()
    }
  }

  /** Stop everything and release the graph. Safe to call multiple times. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopSources()
    try {
      this.gain.gain.cancelScheduledValues(this.ctx.currentTime)
      this.gain.disconnect()
    } catch {
      /* already disconnected */
    }
    this.playing = false
  }

  /** Mark the run finished exactly once and notify. */
  private finish(): void {
    if (this.ended) return
    this.playing = false
    const last = this.plan && this.plan.segments.length > 0 ? this.plan.segments[this.plan.segments.length - 1] : null
    this.pausedAt = last ? last.origEnd : this.pausedAt
    this.ended = true
    this.onEnded?.()
  }

  private stopSources(): void {
    if (this.endCheckTimer !== null) {
      clearTimeout(this.endCheckTimer)
      this.endCheckTimer = null
    }
    const entries = this.scheduled
    this.scheduled = []
    this.clock.clear()
    // A hard stop clicks: ramp each segment down over a few ms, then stop and disconnect it.
    const now = this.ctx.currentTime
    const fade = 0.008
    for (const entry of entries) {
      const disconnect = (): void => {
        try {
          entry.source.disconnect()
          entry.gain.disconnect()
        } catch {
          /* already disconnected */
        }
      }
      const gain = entry.gain.gain
      try {
        if (typeof gain.cancelAndHoldAtTime === 'function') gain.cancelAndHoldAtTime(now)
        else {
          gain.cancelScheduledValues(now)
          gain.setValueAtTime(Math.max(0.0001, gain.value), now)
        }
        gain.linearRampToValueAtTime(0.0001, now + fade)
        entry.source.onended = disconnect
        entry.source.stop(now + fade + 0.002)
      } catch {
        entry.source.onended = null
        disconnect()
      }
    }
  }

  /**
   * Track the end of the playable region even if the source's `onended` never fires (some browsers
   * skip it when the tab is throttled). Uses the clock derived from AudioContext time, not a
   * drift-prone interval.
   */
  private scheduleEndCheck(): void {
    if (this.endCheckTimer !== null) clearTimeout(this.endCheckTimer)
    const remaining = Math.max(0.05, this.planDuration - this.planTime)
    this.endCheckTimer = setTimeout(
      () => {
        this.endCheckTimer = null
        if (this.disposed || !this.playing || this.ended) return
        if (this.clock.finishedAt(this.ctx.currentTime) || this.planTime >= this.planDuration - 0.02) {
          this.finish()
        } else {
          this.scheduleEndCheck()
        }
      },
      Math.min(1000, (remaining + 0.15) * 1000),
    )
  }
}
