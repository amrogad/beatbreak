/**
 * Interface sounds.
 *
 * Small, synthesized feedback for clicks, toggles and key captures — in the spirit of the
 * interface-sound palette Keyboard Warrior credits in its notices (Kenney's CC0 pluck/select/
 * click/tick pack for judgements, CC0 vintage-keyboard recordings for menu typing). Nothing is
 * sampled or bundled here: every sound is generated with the Web Audio API at call time, which
 * keeps the app license-clean and asset-free. Gameplay itself is silent — as in StepMania, the
 * song is the only thing you hear while playing.
 *
 * Rules:
 *  - Every sound is short (6–220 ms) and quiet; the master volume scales all of them.
 *  - Per-name throttling means dragging a slider cannot machine-gun the same blip.
 *  - All nodes are disconnected when they finish; nothing is left on the graph.
 *  - When disabled (setting off) or before any user gesture, calls are cheap no-ops.
 */
import { getAudioContext, resumeAudioContext } from './engine'

export interface SfxConfig {
  enabled: boolean
  /** Master volume 0..1 (usually the same value as the music volume). */
  volume: number
}

let config: SfxConfig = { enabled: true, volume: 0.9 }
const lastPlayed = new Map<string, number>()
const noiseCache = new WeakMap<AudioContext, AudioBuffer>()

/** Update the global sfx configuration (called whenever settings change). */
export function configureSfx(next: Partial<SfxConfig>): void {
  config = { ...config, ...next }
}

/** Minimum gap between two plays of the same sound, ms. */
const THROTTLE_MS: Record<string, number> = {
  click: 35,
  select: 45,
  confirm: 60,
  tick: 22,
  key: 16,
  error: 120,
  back: 60,
  fail: 1000,
}

function playable(name: string): AudioContext | null {
  if (!config.enabled || config.volume <= 0.001) return null
  const now = nowMs()
  const gap = THROTTLE_MS[name] ?? 0
  const last = lastPlayed.get(name) ?? -Infinity
  if (now - last < gap) return null
  lastPlayed.set(name, now)
  try {
    const ctx = getAudioContext()
    // The first call always comes from a user gesture (a click), so resuming is allowed here.
    if (ctx.state === 'suspended') void resumeAudioContext().catch(() => undefined)
    return ctx
  } catch {
    return null
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function gainOf(level: number): number {
  return Math.max(0, Math.min(1, level)) * Math.max(0, Math.min(1, config.volume))
}

function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const cached = noiseCache.get(ctx)
  if (cached) return cached
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.05)), ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  noiseCache.set(ctx, buffer)
  return buffer
}

/** Tonal blip with an exponential decay. */
function blip(
  ctx: AudioContext,
  options: {
    type: OscillatorType
    frequency: number
    endFrequency?: number
    duration: number
    peak: number
    delay?: number
    filterFrequency?: number
  },
): void {
  const at = ctx.currentTime + (options.delay ?? 0.001)
  const oscillator = ctx.createOscillator()
  const envelope = ctx.createGain()
  oscillator.type = options.type
  oscillator.frequency.setValueAtTime(Math.max(20, options.frequency), at)
  if (options.endFrequency && options.endFrequency !== options.frequency) {
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, options.endFrequency), at + options.duration)
  }
  const peak = gainOf(options.peak)
  envelope.gain.setValueAtTime(0.0001, at)
  envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + 0.004)
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + options.duration)
  let tail: AudioNode = oscillator
  if (options.filterFrequency) {
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = options.filterFrequency
    oscillator.connect(filter)
    tail = filter
  }
  tail.connect(envelope)
  envelope.connect(ctx.destination)
  oscillator.start(at)
  oscillator.stop(at + options.duration + 0.02)
  oscillator.onended = () => {
    oscillator.disconnect()
    envelope.disconnect()
  }
}

/** Filtered noise burst: the click/keystroke half of the palette. */
function noise(
  ctx: AudioContext,
  options: { center: number; q?: number; duration: number; peak: number; delay?: number },
): void {
  const at = ctx.currentTime + (options.delay ?? 0.001)
  const source = ctx.createBufferSource()
  source.buffer = noiseBuffer(ctx)
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.value = options.center
  filter.Q.value = options.q ?? 0.9
  const envelope = ctx.createGain()
  const peak = gainOf(options.peak)
  envelope.gain.setValueAtTime(0.0001, at)
  envelope.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + 0.003)
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + options.duration)
  source.connect(filter)
  filter.connect(envelope)
  envelope.connect(ctx.destination)
  source.start(at)
  source.stop(at + options.duration + 0.02)
  source.onended = () => {
    source.disconnect()
    filter.disconnect()
    envelope.disconnect()
  }
}

/* ------------------------------------------------------------------- sounds */

/** Button / chip click. */
export function sfxClick(): void {
  const ctx = playable('click')
  if (!ctx) return
  noise(ctx, { center: 2100, duration: 0.028, peak: 0.075 })
  blip(ctx, { type: 'triangle', frequency: 420, endFrequency: 300, duration: 0.045, peak: 0.05 })
}

/** Select / dropdown change: a soft pop. */
export function sfxSelect(): void {
  const ctx = playable('select')
  if (!ctx) return
  blip(ctx, { type: 'sine', frequency: 520, endFrequency: 880, duration: 0.09, peak: 0.09 })
  noise(ctx, { center: 2600, duration: 0.014, peak: 0.03 })
}

/** Primary action / confirmation: a short pluck. */
export function sfxConfirm(): void {
  const ctx = playable('confirm')
  if (!ctx) return
  blip(ctx, { type: 'sawtooth', frequency: 640, endFrequency: 620, duration: 0.18, peak: 0.085, filterFrequency: 2400 })
  blip(ctx, { type: 'triangle', frequency: 960, duration: 0.12, peak: 0.045 })
  noise(ctx, { center: 3200, duration: 0.012, peak: 0.025 })
}

/** Toggle tick; `on` raises the pitch, `off` lowers it. */
export function sfxTick(on = true): void {
  const ctx = playable('tick')
  if (!ctx) return
  blip(ctx, { type: 'square', frequency: on ? 3300 : 2200, duration: 0.03, peak: 0.035 })
}

/** Menu keystroke (five pitch variants, like a sampled keyboard). */
export function sfxKey(): void {
  const ctx = playable('key')
  if (!ctx) return
  const variant = [0.82, 0.92, 1, 1.12, 1.26][Math.floor(Math.random() * 5)]
  noise(ctx, { center: 1500 * variant, q: 0.7, duration: 0.03, peak: 0.06 })
  blip(ctx, { type: 'sine', frequency: 150 * variant, endFrequency: 110, duration: 0.04, peak: 0.05 })
  noise(ctx, { center: 5200 * variant, q: 1.4, duration: 0.008, peak: 0.02 })
}

/** Refusal / problem feedback: a low double thud. */
export function sfxError(): void {
  const ctx = playable('error')
  if (!ctx) return
  blip(ctx, { type: 'sawtooth', frequency: 210, endFrequency: 160, duration: 0.12, peak: 0.06, filterFrequency: 900 })
  blip(ctx, { type: 'sawtooth', frequency: 160, endFrequency: 120, duration: 0.14, peak: 0.05, delay: 0.09, filterFrequency: 700 })
}

/** Run failed: a descending three-note "womp" that cannot be mistaken for a hit sound. */
export function sfxFail(): void {
  const ctx = playable('fail')
  if (!ctx) return
  blip(ctx, { type: 'sawtooth', frequency: 330, endFrequency: 300, duration: 0.16, peak: 0.085, filterFrequency: 1200 })
  blip(ctx, { type: 'sawtooth', frequency: 247, endFrequency: 225, duration: 0.2, peak: 0.085, delay: 0.17, filterFrequency: 1000 })
  blip(ctx, { type: 'sawtooth', frequency: 165, endFrequency: 98, duration: 0.55, peak: 0.1, delay: 0.36, filterFrequency: 700 })
}

/** Back / dismiss: two quick descending ticks. */
export function sfxBack(): void {
  const ctx = playable('back')
  if (!ctx) return
  blip(ctx, { type: 'square', frequency: 2900, duration: 0.025, peak: 0.03 })
  blip(ctx, { type: 'square', frequency: 2100, duration: 0.03, peak: 0.028, delay: 0.055 })
}

/* ------------------------------------------------------- global UI listener */

/**
 * Wire the palette into the whole DOM with two delegated listeners: any press of a button-like
 * element plays a click (primary actions get the pluck) and any select/checkbox/range change
 * plays the matching feedback. Returns a cleanup function.
 */
export function attachUiSounds(): () => void {
  if (typeof document === 'undefined') return () => undefined

  const soundFor = (element: Element): void => {
    if (element.classList.contains('keycap')) {
      sfxKey()
      return
    }
    if (element.classList.contains('btn-primary')) {
      sfxConfirm()
      return
    }
    if (element.classList.contains('btn-danger')) {
      sfxBack()
      return
    }
    sfxClick()
  }

  const onPointerDown = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest('button, [role="button"]')
    if (!button) return
    if (button instanceof HTMLButtonElement && button.disabled) return
    soundFor(button)
  }

  const onClick = (event: Event): void => {
    // Keyboard activation (Enter/Space on a focused control) has detail === 0.
    if (event instanceof MouseEvent && event.detail !== 0) return
    const target = event.target
    if (!(target instanceof Element)) return
    const button = target.closest('button, [role="button"]')
    if (!button) return
    if (button instanceof HTMLButtonElement && button.disabled) return
    sfxClick()
  }

  const onChange = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    if (target instanceof HTMLSelectElement) {
      sfxSelect()
      return
    }
    if (target instanceof HTMLInputElement) {
      if (target.type === 'checkbox') sfxTick(target.checked)
      else if (target.type === 'range') sfxTick(true)
    }
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('change', onChange, true)
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('change', onChange, true)
  }
}
