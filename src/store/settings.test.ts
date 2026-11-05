import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, loadSettings, sanitizeSettings, saveSettings } from './settings'

const STORAGE_KEY = 'pulsegrid:settings:v1'

/** Minimal in-memory localStorage for the migration and round-trip tests. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, String(value)),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sanitizeSettings', () => {
  it('fills missing fields with defaults and clamps every number', () => {
    const settings = sanitizeSettings({ volume: 4, scrollSpeed: 99, noteShape: 'nonsense' })
    expect(settings.volume).toBe(1)
    expect(settings.scrollSpeed).toBe(10)
    expect(settings.noteShape).toBe('arrow')
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings({ volume: 'loud' }).volume).toBe(DEFAULT_SETTINGS.volume)
  })

  it('accepts the StepMania preset and rejects unknown ones', () => {
    expect(sanitizeSettings({ windowPreset: 'stepmania' }).windowPreset).toBe('stepmania')
    expect(sanitizeSettings({ windowPreset: 'nonsense' }).windowPreset).toBe('standard')
    expect(sanitizeSettings({ failRule: 'nonsense' }).failRule).toBe(DEFAULT_SETTINGS.failRule)
  })

  it('repairs key collisions without discarding the rest of the player\'s mapping', () => {
    const clash = sanitizeSettings({
      keyMap: { left: ['KeyA'], down: ['KeyA'], up: ['ArrowUp'], right: ['ArrowRight'] },
    })
    expect(clash.keyMap.left).toEqual(['KeyA'])
    expect(clash.keyMap.down).toEqual(['KeyS'])
    expect(clash.keyMap.up).toEqual(['ArrowUp'])
    expect(clash.keyMap.right).toEqual(['ArrowRight'])

    const partial = sanitizeSettings({ keyMap: { left: [], down: ['KeyJ'] } }).keyMap
    expect(partial.left).toEqual(DEFAULT_SETTINGS.keyMap.left)
    expect(partial.down).toEqual(['KeyJ'])
  })

  it('normalises custom windows into order and inside the allowed range', () => {
    const { customWindows } = sanitizeSettings({ customWindows: { marvelous: 20, perfect: 10, great: 60, good: 30 } })
    expect(customWindows).toEqual({ marvelous: 20, perfect: 20, great: 60, good: 60 })

    const clamped = sanitizeSettings({ customWindows: { marvelous: 1, perfect: 5, great: 50, good: 500 } }).customWindows
    expect(clamped.marvelous).toBe(4)
    expect(clamped.good).toBe(300)
  })
})

describe('settings migration and storage', () => {
  it('migrates an old blob and ignores fields that no longer exist', () => {
    vi.stubGlobal(
      'localStorage',
      fakeStorage({
        [STORAGE_KEY]: JSON.stringify({
          hitSounds: true,
          offsetMs: 120,
          autoPlay: true,
          volume: 0.42,
          noteShape: 'diamond',
          theme: 'neon',
        }),
      }),
    )
    const migrated = loadSettings()
    expect(migrated.autoPlay).toBe(false)
    // Removed fields are gone rather than half-supported.
    expect('hitSounds' in migrated).toBe(false)
    expect('offsetMs' in migrated).toBe(false)
    // Everything else survives the migration untouched.
    expect(migrated.volume).toBe(1)
    expect(migrated.noteShape).toBe('diamond')
    expect(migrated.theme).toBe('neon')
    expect('rememberAudio' in migrated).toBe(false)
    expect('beatLines' in migrated).toBe(false)
    expect('receptorScale' in migrated).toBe(false)
    expect(migrated.failRule).toBe('never')
    expect(migrated.uiSounds).toBe(true)
    expect(migrated.noteScale).toBe(DEFAULT_SETTINGS.noteScale)
    expect(migrated.windowPreset).toBe('standard')
  })

  it('never resurrects the old hit-sound option from a newer blob', () => {
    vi.stubGlobal(
      'localStorage',
      fakeStorage({ [STORAGE_KEY]: JSON.stringify({ schema: 3, hitSounds: true, autoPlay: true, volume: 0.7 }) }),
    )
    const settings = loadSettings()
    expect(settings.autoPlay).toBe(false)
    expect(settings.volume).toBe(1)
    expect('hitSounds' in settings).toBe(false)
    // v4 moves early players off the arcade fail rule once.
    expect(settings.failRule).toBe('never')
  })

  it('adds arrow aliases to an old key map and persists the migration', () => {
    const storage = fakeStorage({
      [STORAGE_KEY]: JSON.stringify({
        schema: 3,
        keyMap: { left: ['KeyA'], down: ['KeyS'], up: ['KeyW'], right: ['KeyD'] },
      }),
    })
    vi.stubGlobal('localStorage', storage)
    const settings = loadSettings()
    expect(settings.keyMap.left).toEqual(['KeyA', 'ArrowLeft'])
    expect(settings.keyMap.down).toEqual(['KeyS', 'ArrowDown'])
    expect(settings.keyMap.up).toEqual(['KeyW', 'ArrowUp'])
    expect(settings.keyMap.right).toEqual(['KeyD', 'ArrowRight'])
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as { schema?: number }
    expect(raw.schema).toBe(9)
  })

  it('stamps the current schema on save and round-trips through load', () => {
    const storage = fakeStorage()
    vi.stubGlobal('localStorage', storage)
    saveSettings({ ...DEFAULT_SETTINGS, volume: 0.25, windowPreset: 'stepmania' })
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as { schema?: number }
    expect(raw.schema).toBe(9)
    const reloaded = loadSettings()
    expect(reloaded.volume).toBe(0.25)
    expect(reloaded.windowPreset).toBe('stepmania')
  })

  it('falls back to defaults when storage is blocked or the blob is corrupt', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow()

    vi.stubGlobal('localStorage', fakeStorage({ [STORAGE_KEY]: 'not json at all' }))
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })
})
