/**
 * Player settings.
 *
 * Stored in localStorage (small, synchronous, and available even when IndexedDB is blocked) with
 * defensive parsing: a settings blob from an older build — or a hand-edited one — must never be
 * able to put the app in a broken state, so every field is clamped or rejected.
 */
import type { Difficulty, FailRule } from '../core/types'
import { FAIL_RULES } from '../core/types'
import type { ControlMap, KeyMap } from '../game/input'
import { CONTROL_DEFAULTS, DEFAULT_KEYMAP } from '../game/input'
import type { CustomWindows, WindowPreset } from '../game/judgment'
import { normalizeCustomWindows } from '../game/judgment'
import { COLUMN_COLORS } from '../render/renderer'
import type { ArrowColors, LaneStyle, NoteShape, ScrollDirection, ThemeName } from '../render/renderer'

/** Windowed play always; `fullscreen` asks the browser for fullscreen when a run starts. */
export type DisplayMode = 'window' | 'fullscreen'

export interface Settings {
  /** Master volume 0..1. Defaults to a full mixer; Windows/macOS system volume still applies. */
  volume: number
  /** Interface sounds: clicks, toggles and keystroke taps. Always on; there is no toggle. */
  uiSounds: boolean
  windowPreset: WindowPreset
  /** The four hit windows used when `windowPreset` is 'custom'. */
  customWindows: CustomWindows
  /** When a run fails: never, after N misses, or the arcade accuracy rule. */
  failRule: FailRule
  scrollSpeed: number
  scrollDirection: ScrollDirection
  /** One size control for tap arrows, hold arrows and their receptor ghosts. */
  noteScale: number
  laneStyle: LaneStyle
  noteShape: NoteShape
  theme: ThemeName
  arrowColors: ArrowColors
  /** The colour of each column's arrows, left to right. */
  columnColors: string[]
  displayMode: DisplayMode
  reducedMotion: boolean
  keyMap: KeyMap
  controls: ControlMap
  /** The one-time welcome walkthrough has been dismissed. */
  tutorialSeen: boolean
  /**
   * Auto-play (watch/verify) mode. Persisted so it survives a reload when testing, but the schema
   * migration turns it off once: it masks all key input, which can make a normal run look broken.
   */
  autoPlay: boolean
  /** Show the lightweight in-game performance readout. */
  showStats: boolean
  /** Loop a preview of a song behind the menus. */
  menuMusic: boolean
  /** The song goes dull for a moment on a miss. */
  missMuffle: boolean
  /** Long arrows: let go on the end arrow ('release') or just hold to the end ('hold'). */
  holdMode: 'release' | 'hold'
  /** Long arrows in the chart; off plays each one as a tap. Phones start with them off. */
  longArrows: boolean
  /** How wide the timing windows are: 'phone' is 1.5x wider, since tapping glass is harder. */
  timing: 'pc' | 'phone'
  /** Difficulty a song opens on before you pick one for it; 'auto' uses the recommended one. */
  defaultDifficulty: Difficulty | 'auto'
  /**
   * The player's arrow timing correction in ms: negative moves arrows (and judging) earlier, for
   * setups where the music reaches you before the arrows do. The results screen suggests a value.
   * Zero is the normal setting; {@link arrowOffsetMs} adds the built-in display allowance.
   */
  audioOffsetMs: number
  /** Where song progress shows in a run. */
  progressStyle: 'top' | 'column' | 'text'
  /** Arrows in lanes, or circles to click or tap on a field. */
  playMode: PlayMode
}

export type PlayMode = 'arrows' | 'circles'

export const DEFAULT_SETTINGS: Settings = {
  volume: 1,
  uiSounds: true,
  windowPreset: 'standard',
  customWindows: { marvelous: 15, perfect: 33, great: 60, good: 80 },
  // Casual-friendly default: a first run should reach the results screen even while the player
  // is still learning the lanes. Arcade failure is one click away in Settings.
  failRule: 'never',
  scrollSpeed: 5,
  scrollDirection: 'up',
  noteScale: 1,
  laneStyle: 'neon',
  noteShape: 'arrow',
  theme: 'disco',
  arrowColors: 'column',
  columnColors: [...COLUMN_COLORS],
  displayMode: 'window',
  reducedMotion: false,
  keyMap: DEFAULT_KEYMAP,
  controls: CONTROL_DEFAULTS,
  tutorialSeen: false,
  autoPlay: false,
  showStats: false,
  menuMusic: true,
  missMuffle: true,
  holdMode: 'hold',
  longArrows: true,
  timing: 'pc',
  defaultDifficulty: 'auto',
  // A screen shows a frame a frame or two after it is drawn, so arrows reach the target a little
  // after the beat is heard. 20 ms earlier makes up for a typical monitor; players fine-tune it.
  audioOffsetMs: 0,
  progressStyle: 'top',
  playMode: 'arrows',
}

const STORAGE_KEY = 'pulsegrid:settings:v1'

/**
 * Saved-settings schema. Bumping it runs a one-time migration in `loadSettings`; every other
 * field still comes from the sanitizer so older blobs keep their choices.
 *
 * v2: gameplay is silent by default (StepMania has no hit sounds) and auto-play starts off — a
 *     stored `true` from v1 was almost always the old default, not a deliberate choice.
 * v3: hit sounds and manual audio offset are gone; audio is remembered by default so a song can
 *     be replayed with the same arrows without re-importing it.
 * v4: runs no longer fail by default; the arcade rule was too punishing for a first play.
 * v5: the green terminal skin was the old default; move that default to the disco skin.
 * v6: Settings was cut back to the options that matter. Hidden tuning knobs return to their
 *     defaults, interface sounds are always on, and the one fair timing/fail ruleset applies.
 * v7: the green terminal theme is gone; disco is the only default look.
 * v8: audio is always remembered, beat lines and the separate receptor size are gone, the game
 *     starts at full mixer volume, and one larger Arrow size drives notes, holds and receptors.
 */
const SETTINGS_SCHEMA = 17

/** Screens show a frame or so after the audio clock, so arrows always run this much early. */
const DISPLAY_LEAD_MS = -20

export const arrowOffsetMs = (playerOffsetMs: number): number => playerOffsetMs + DISPLAY_LEAD_MS

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.max(min, Math.min(max, n))
}

function sanitizeKeyList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const list = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(0, 8)
  return list.length > 0 ? list : [...fallback]
}

function sanitizeKeyMap(value: unknown): KeyMap {
  const raw = (value ?? {}) as Partial<KeyMap>
  const map: KeyMap = {
    left: sanitizeKeyList(raw.left, DEFAULT_KEYMAP.left),
    down: sanitizeKeyList(raw.down, DEFAULT_KEYMAP.down),
    up: sanitizeKeyList(raw.up, DEFAULT_KEYMAP.up),
    right: sanitizeKeyList(raw.right, DEFAULT_KEYMAP.right),
  }
  // A key can only belong to one lane. Repair conflicts by keeping the first owner and dropping
  // later duplicates — resetting the whole map to defaults here used to silently undo the player's
  // rebind the moment they moved a default key (e.g. W) to another arrow.
  const used = new Set<string>()
  const spare = ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon']
  for (const lane of ['left', 'down', 'up', 'right'] as (keyof KeyMap)[]) {
    map[lane] = map[lane].filter((code) => {
      if (used.has(code)) return false
      used.add(code)
      return true
    })
    if (map[lane].length === 0) {
      const replacement = [...DEFAULT_KEYMAP[lane], ...spare].find((code) => !used.has(code))
      if (replacement) {
        map[lane] = [replacement]
        used.add(replacement)
      }
    }
  }
  return map
}

function sanitizeControls(value: unknown): ControlMap {
  const raw = (value ?? {}) as Partial<ControlMap>
  return {
    pause: sanitizeKeyList(raw.pause, CONTROL_DEFAULTS.pause),
    restart: sanitizeKeyList(raw.restart, CONTROL_DEFAULTS.restart),
    fullscreen: sanitizeKeyList(raw.fullscreen, CONTROL_DEFAULTS.fullscreen),
  }
}

export function sanitizeSettings(input: unknown): Settings {
  const raw = (input ?? {}) as Partial<Settings>
  const windowPreset: WindowPreset =
    raw.windowPreset === 'strict' ||
    raw.windowPreset === 'standard' ||
    raw.windowPreset === 'stepmania' ||
    raw.windowPreset === 'lenient' ||
    raw.windowPreset === 'custom'
      ? raw.windowPreset
      : DEFAULT_SETTINGS.windowPreset
  const laneStyle: LaneStyle = raw.laneStyle === 'classic' || raw.laneStyle === 'minimal' ? raw.laneStyle : 'neon'
  const noteShape: NoteShape =
    raw.noteShape === 'bar' ||
    raw.noteShape === 'chevron' ||
    raw.noteShape === 'diamond' ||
    raw.noteShape === 'orb' ||
    raw.noteShape === 'star' ||
    raw.noteShape === 'hex' ||
    raw.noteShape === 'tile' ||
    raw.noteShape === 'square'
      ? raw.noteShape
      : 'arrow'
  const scrollDirection: ScrollDirection = raw.scrollDirection === 'down' ? 'down' : 'up'
  // The phosphor-green terminal skin was removed: any old saved value falls back to disco.
  const theme: ThemeName = raw.theme === 'neon' ? 'neon' : raw.theme === 'mono' ? 'mono' : 'disco'
  const arrowColors: ArrowColors = raw.arrowColors === 'random' ? 'random' : 'column'
  const displayMode: DisplayMode = raw.displayMode === 'fullscreen' ? 'fullscreen' : 'window'
  const failRule: FailRule =
    typeof raw.failRule === 'string' && (FAIL_RULES as readonly string[]).includes(raw.failRule)
      ? (raw.failRule as FailRule)
      : DEFAULT_SETTINGS.failRule
  return {
    volume: clamp(raw.volume, 0, 1, DEFAULT_SETTINGS.volume),
    uiSounds: typeof raw.uiSounds === 'boolean' ? raw.uiSounds : DEFAULT_SETTINGS.uiSounds,
    windowPreset,
    customWindows: normalizeCustomWindows(raw.customWindows),
    failRule,
    scrollSpeed: clamp(raw.scrollSpeed, 1, 10, DEFAULT_SETTINGS.scrollSpeed),
    scrollDirection,
    noteScale: clamp(raw.noteScale, 0.6, 1.3, DEFAULT_SETTINGS.noteScale),
    laneStyle,
    noteShape,
    theme,
    arrowColors,
    columnColors:
      Array.isArray(raw.columnColors) && raw.columnColors.length === 4 && raw.columnColors.every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))
        ? [...raw.columnColors]
        : [...COLUMN_COLORS],
    displayMode,
    reducedMotion: typeof raw.reducedMotion === 'boolean' ? raw.reducedMotion : DEFAULT_SETTINGS.reducedMotion,
    keyMap: sanitizeKeyMap(raw.keyMap),
    controls: sanitizeControls(raw.controls),
    tutorialSeen: typeof raw.tutorialSeen === 'boolean' ? raw.tutorialSeen : DEFAULT_SETTINGS.tutorialSeen,
    autoPlay: typeof raw.autoPlay === 'boolean' ? raw.autoPlay : DEFAULT_SETTINGS.autoPlay,
    showStats: typeof raw.showStats === 'boolean' ? raw.showStats : DEFAULT_SETTINGS.showStats,
    menuMusic: typeof raw.menuMusic === 'boolean' ? raw.menuMusic : DEFAULT_SETTINGS.menuMusic,
    missMuffle: typeof raw.missMuffle === 'boolean' ? raw.missMuffle : DEFAULT_SETTINGS.missMuffle,
    holdMode: raw.holdMode === 'release' ? 'release' : 'hold',
    longArrows: typeof raw.longArrows === 'boolean' ? raw.longArrows : DEFAULT_SETTINGS.longArrows,
    timing: raw.timing === 'phone' ? 'phone' : 'pc',
    defaultDifficulty:
      raw.defaultDifficulty === 'easy' || raw.defaultDifficulty === 'normal' || raw.defaultDifficulty === 'hard' || raw.defaultDifficulty === 'expert'
        ? raw.defaultDifficulty
        : 'auto',
    audioOffsetMs: Math.round(clamp(raw.audioOffsetMs, -250, 250, DEFAULT_SETTINGS.audioOffsetMs)),
    progressStyle: raw.progressStyle === 'column' || raw.progressStyle === 'text' ? raw.progressStyle : 'top',
    playMode: raw.playMode === 'circles' ? 'circles' : 'arrows',
  }
}

/**
 * Phones and tablets start the other way up: piano tiles falling to targets at the bottom, where
 * thumbs are. Only for a first visit; a saved choice always wins.
 */
function touchDefaults(): Partial<Settings> {
  const touch = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches
  return touch ? { scrollDirection: 'down', noteShape: 'tile', timing: 'phone', reducedMotion: true, longArrows: false } : {}
}

export function loadSettings(): Settings {
  try {
    const text = localStorage.getItem(STORAGE_KEY)
    if (!text) return { ...DEFAULT_SETTINGS, ...touchDefaults() }
    const parsed = JSON.parse(text) as Partial<Settings> & { schema?: number }
    if ((parsed.schema ?? 1) < SETTINGS_SCHEMA) {
      // v5: terminal was the app's default, not a choice the player made. Move it to disco;
      // an explicit 'neon' choice is left alone.
      if ((parsed.schema ?? 1) < 7) parsed.theme = parsed.theme === 'neon' ? 'neon' : 'disco'
      if ((parsed.schema ?? 1) < 6) {
        // These controls left the UI. Their old saved values must not quietly keep changing how
        // the game feels, so the shared defaults are restored once.
        parsed.noteScale = 1
        parsed.laneStyle = 'neon'
        parsed.windowPreset = 'stepmania'
        parsed.failRule = 'never'
        parsed.autoPlay = false
        parsed.uiSounds = true
      }
      parsed.autoPlay = false
      // v9: the default timing windows got tighter; the old default preset moves to the new one.
      if ((parsed.schema ?? 1) < 9 && parsed.windowPreset === 'stepmania') parsed.windowPreset = 'standard'
      // v10: the windows tightened again; every preset except a hand-set one moves to the default.
      if ((parsed.schema ?? 1) < 10 && parsed.windowPreset !== 'custom') parsed.windowPreset = 'standard'
      // v11: arrow size is shown relative to the default (100%) instead of a raw 130%.
      if ((parsed.schema ?? 1) < 11 && typeof parsed.noteScale === 'number') parsed.noteScale = parsed.noteScale / 1.3
      // v16: phones start without long arrows (Amro, 2026-11-06).
      // The old default of -20 ms was the display allowance; it now lives in arrowOffsetMs.
      if ((parsed.schema ?? 1) < 17 && typeof parsed.audioOffsetMs === 'number') parsed.audioOffsetMs -= DISPLAY_LEAD_MS
      if ((parsed.schema ?? 1) < 16 && touchDefaults().longArrows === false) parsed.longArrows = false
      // v15: phones start with effects off, for a smoother game (Amro, 2026-11-06).
      if ((parsed.schema ?? 1) < 15 && touchDefaults().reducedMotion) parsed.reducedMotion = true
      // v14: phones and tablets start on the wider phone timing.
      if ((parsed.schema ?? 1) < 14 && touchDefaults().timing) parsed.timing = 'phone'
      // v13: holds only ask you to keep holding by default, no timed release.
      if ((parsed.schema ?? 1) < 13) parsed.holdMode = 'hold'
      // v12: phones and tablets start on falling piano tiles, also when settings were saved before.
      if ((parsed.schema ?? 1) < 12) Object.assign(parsed, touchDefaults())
      if ((parsed.schema ?? 1) < 8) {
        // v8: the mixer used to start at 90%. A full mixer is the closest a browser can get to
        // "follow the system volume" (the OS level is applied after this gain). The old note and
        // receptor sliders were hidden, so their stored values were not deliberate choices.
        parsed.volume = 1
        parsed.noteScale = DEFAULT_SETTINGS.noteScale
      }
      // v4: failure used to default to the arcade accuracy rule, which ended a first run before
      // a new player had a chance to learn the controls. Reset it once to the casual default.
      if ((parsed.schema ?? 1) < 4) {
        parsed.failRule = 'never'
        // Arrow keys now work alongside WASD. Add the matching arrow as an alias without
        // touching custom bindings; the sanitizer resolves any collision.
        const aliases: Record<keyof KeyMap, string> = {
          left: 'ArrowLeft',
          down: 'ArrowDown',
          up: 'ArrowUp',
          right: 'ArrowRight',
        }
        const keyMap = parsed.keyMap as Partial<Record<keyof KeyMap, string[]>> | undefined
        if (keyMap && typeof keyMap === 'object') {
          for (const lane of Object.keys(aliases) as (keyof KeyMap)[]) {
            const keys = keyMap[lane]
            if (Array.isArray(keys) && !keys.includes(aliases[lane])) {
              keyMap[lane] = [...keys, aliases[lane]]
            }
          }
        }
      }
    }
    const migrated = sanitizeSettings(parsed)
    if ((parsed.schema ?? 1) < SETTINGS_SCHEMA) saveSettings(migrated)
    return migrated
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, schema: SETTINGS_SCHEMA }))
  } catch {
    // Storage full or blocked: the in-memory settings still apply for this session.
  }
}

/**
 * Observable settings store. React reads it through `useSyncExternalStore`, so any screen that
 * changes a setting updates every other screen without prop plumbing.
 */
export class SettingsStore {
  private value: Settings
  private listeners = new Set<() => void>()

  constructor(initial: Settings = loadSettings()) {
    this.value = initial
  }

  /**
   * Arrow property on purpose: the store is read through `useSyncExternalStore(store.subscribe,
   * store.get, store.get)`, which calls these functions without a receiver — a prototype method
   * would crash on `this`.
   */
  get = (): Settings => {
    return this.value
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  update(patch: Partial<Settings>): Settings {
    this.value = sanitizeSettings({ ...this.value, ...patch })
    saveSettings(this.value)
    for (const listener of this.listeners) listener()
    return this.value
  }

  reset(): Settings {
    this.value = { ...DEFAULT_SETTINGS }
    saveSettings(this.value)
    for (const listener of this.listeners) listener()
    return this.value
  }
}

export const settingsStore = new SettingsStore()
