/**
 * Keyboard input.
 *
 * Uses `KeyboardEvent.code` (physical key) so the layout does not matter, and keeps the original
 * `event.timeStamp` so hit detection can compensate for main-thread lag. The default lane keys
 * are W/A/S/D matched to the arrow directions (up/left/down/right); every lane is rebindable in
 * Settings, and players can add extra keys (e.g. the arrow keys) per lane.
 */
import type { Lane } from '../core/types'

export interface KeyMap {
  left: string[]
  down: string[]
  up: string[]
  right: string[]
}

export const DEFAULT_KEYMAP: KeyMap = {
  left: ['KeyA', 'ArrowLeft'],
  down: ['KeyS', 'ArrowDown'],
  up: ['KeyW', 'ArrowUp'],
  right: ['KeyD', 'ArrowRight'],
}

export const CONTROL_DEFAULTS = {
  pause: ['Escape'],
  restart: ['KeyR'],
  fullscreen: ['KeyF'],
}

export interface ControlMap {
  pause: string[]
  restart: string[]
  fullscreen: string[]
}

export const LANE_ORDER: Lane[] = [0, 1, 2, 3]

const LANE_KEYS = ['left', 'down', 'up', 'right'] as const

/**
 * Move `code` onto `lane`, keeping every lane playable. A key can drive only one lane, so taking
 * it from another lane either leaves that lane with its other keys or swaps the displaced key
 * back. This is the difference between rebinding W and accidentally resetting the whole WASD
 * map: the old lane ends up with the key you replaced instead of an empty list.
 */
export function rebindLaneKey(current: KeyMap, lane: Lane, code: string, swapCandidate?: string): KeyMap {
  const target = LANE_KEYS[lane]
  const map: KeyMap = {
    left: [...current.left],
    down: [...current.down],
    up: [...current.up],
    right: [...current.right],
  }
  const owner = LANE_KEYS.find((key) => key !== target && map[key].includes(code)) ?? null
  const displaced = swapCandidate && swapCandidate !== code ? swapCandidate : map[target].find((key) => key !== code) ?? null
  for (const key of LANE_KEYS) {
    map[key] = map[key].filter((existing) => existing !== code)
  }
  if (owner && map[owner].length === 0 && displaced) {
    map[owner] = [displaced]
    map[target] = map[target].filter((existing) => existing !== displaced)
  }
  // Clicking an existing key cap replaces that key. Only "+ key" adds a second binding, so the
  // clicked key must go even when the new key came from a free key or a lane that kept another
  // key. Leaving it behind was why rebinding could look like it "did nothing" and accrete keys.
  if (swapCandidate && swapCandidate !== code) {
    map[target] = map[target].filter((existing) => existing !== swapCandidate)
  }
  if (!map[target].includes(code)) map[target] = [...map[target], code]
  return map
}

export function laneForKey(code: string, keyMap: KeyMap = DEFAULT_KEYMAP): Lane | null {
  if (keyMap.left.includes(code)) return 0
  if (keyMap.down.includes(code)) return 1
  if (keyMap.up.includes(code)) return 2
  if (keyMap.right.includes(code)) return 3
  return null
}

/** Human-readable key name for the settings screen ("ArrowLeft" → "←"). */
export function describeKey(code: string): string {
  const arrows: Record<string, string> = {
    ArrowLeft: '←',
    ArrowDown: '↓',
    ArrowUp: '↑',
    ArrowRight: '→',
    Space: 'Space',
    Escape: 'Esc',
    Enter: 'Enter',
    ShiftLeft: 'L-Shift',
    ShiftRight: 'R-Shift',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Minus: '-',
    Equal: '=',
    Backquote: '`',
  }
  if (arrows[code]) return arrows[code]
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`
  return code
}

export interface InputHandlers {
  onLaneDown: (lane: Lane, eventTimeMs: number, code: string) => void
  onLaneUp?: (lane: Lane, eventTimeMs: number, code: string) => void
  onPause?: (eventTimeMs: number) => void
  onRestart?: () => void
  onFullscreen?: () => void
  /** Returns true when the key should be swallowed (prevents page scrolling etc.). */
  shouldPreventDefault?: (code: string) => boolean
}

export interface InputRouterOptions {
  keyMap: KeyMap
  controls?: ControlMap
  /** When true, lane keys are ignored (menus, pause overlay). */
  enabled?: () => boolean
}

/**
 * Attaches listeners to a target element and translates key events into lane presses.
 * Every listener it adds is removed by `dispose()`.
 */
export class InputRouter {
  private target: Window | HTMLElement
  private options: InputRouterOptions
  private handlers: InputHandlers
  /** Tracks which physical key currently holds a lane down, so auto-repeat is filtered out. */
  private held = new Set<string>()
  private disposed = false

  constructor(target: Window | HTMLElement, handlers: InputHandlers, options: InputRouterOptions) {
    this.target = target
    this.handlers = handlers
    this.options = options
    window.addEventListener('keydown', this.onKeyDown, { capture: true })
    window.addEventListener('keyup', this.onKeyUp, { capture: true })
    window.addEventListener('blur', this.onBlur)
    // Some keyboard/OS combinations lose keyup while alt-tabbing.
    document.addEventListener('visibilitychange', this.onBlur)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    window.removeEventListener('keydown', this.onKeyDown, { capture: true })
    window.removeEventListener('keyup', this.onKeyUp, { capture: true })
    window.removeEventListener('blur', this.onBlur)
    document.removeEventListener('visibilitychange', this.onBlur)
    this.held.clear()
  }

  /** Keyups are lost while the window is unfocused, so release every held lane here. */
  private onBlur = (): void => {
    const released = [...this.held]
    this.held.clear()
    const now = performance.now()
    for (const code of released) {
      const lane = laneForKey(code, this.options.keyMap)
      if (lane !== null) this.handlers.onLaneUp?.(lane, now, code)
    }
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed) return
    const code = event.code || event.key
    const controls = this.options.controls ?? CONTROL_DEFAULTS
    const enabled = this.options.enabled?.() ?? true
    const isControl = controls.pause.includes(code) || controls.restart.includes(code) || controls.fullscreen.includes(code)
    if (isControl && event.repeat) {
      event.preventDefault()
      return
    }

    if (controls.pause.includes(code)) {
      event.preventDefault()
      this.handlers.onPause?.(event.timeStamp)
      return
    }
    if (controls.restart.includes(code)) {
      if (!enabled) return
      event.preventDefault()
      this.handlers.onRestart?.()
      return
    }
    if (controls.fullscreen.includes(code)) {
      event.preventDefault()
      this.handlers.onFullscreen?.()
      return
    }

    if (!enabled) return
    const lane = laneForKey(code, this.options.keyMap)
    if (lane === null) return
    if (this.held.has(code)) {
      event.preventDefault()
      return // ignore OS auto-repeat
    }
    this.held.add(code)
    if (this.handlers.shouldPreventDefault?.(code) ?? true) event.preventDefault()
    this.handlers.onLaneDown(lane, event.timeStamp, code)
  }

  private onKeyUp = (event: KeyboardEvent): void => {
    const code = event.code || event.key
    this.held.delete(code)
    const lane = laneForKey(code, this.options.keyMap)
    if (lane !== null) this.handlers.onLaneUp?.(lane, event.timeStamp, code)
  }
}

/**
 * Touch/pointer lane zones for tablets and touch laptops. Each zone reports presses with the
 * event timestamp so the same latency compensation applies as for the keyboard.
 */
export function attachTouchLanes(
  element: HTMLElement,
  handlers: {
    onLaneDown: (lane: Lane, eventTimeMs: number) => void
    onLaneUp?: (lane: Lane, eventTimeMs: number) => void
    /** Map an x position (pixels from the element's left) to a column; defaults to equal quarters. */
    laneAt?: (x: number) => Lane | null
  },
): () => void {
  const active = new Map<number, Lane>()
  const laneFromEvent = (event: PointerEvent): Lane | null => {
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0) return null
    if (handlers.laneAt) return handlers.laneAt(event.clientX - rect.left)
    const relative = (event.clientX - rect.left) / rect.width
    if (relative < 0 || relative > 1) return null
    const lane = Math.floor(relative * 4)
    return (lane < 0 ? 0 : lane > 3 ? 3 : lane) as Lane
  }
  const down = (event: PointerEvent): void => {
    const lane = laneFromEvent(event)
    if (lane === null) return
    active.set(event.pointerId, lane)
    handlers.onLaneDown(lane, event.timeStamp)
  }
  const up = (event: PointerEvent): void => {
    const lane = active.get(event.pointerId)
    if (lane === undefined) return
    active.delete(event.pointerId)
    handlers.onLaneUp?.(lane, event.timeStamp)
  }
  element.addEventListener('pointerdown', down)
  element.addEventListener('pointerup', up)
  element.addEventListener('pointercancel', up)
  element.addEventListener('pointerleave', up)
  return () => {
    element.removeEventListener('pointerdown', down)
    element.removeEventListener('pointerup', up)
    element.removeEventListener('pointercancel', up)
    element.removeEventListener('pointerleave', up)
    active.clear()
  }
}
