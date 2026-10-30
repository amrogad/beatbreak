/**
 * Deterministic pseudo-random numbers.
 *
 * Chart generation must be reproducible: the same song, difficulty and seed always produce the
 * same chart. That makes charts shareable, lets the editor diff them, and makes tests stable.
 */

/** FNV-1a style string hash → 32-bit unsigned. */
export function hashString(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number
  /** Uniform integer in [0, max). */
  int(max: number): number
  /** Uniform float in [min, max). */
  range(min: number, max: number): number
  /** Random element of a non-empty array. */
  pick<T>(items: readonly T[]): T
  /** Weighted pick; weights must be non-negative and match `items.length`. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T
  /** True with probability p. */
  chance(p: number): boolean
  /** Current internal state, so nested generators can be seeded deterministically. */
  readonly seed: number
}

/** mulberry32 — small, fast, well-distributed for our purposes. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e3779b9
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const rng: Rng = {
    next,
    int: (max: number) => Math.floor(next() * max),
    range: (min: number, max: number) => min + next() * (max - min),
    pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    weighted: <T,>(items: readonly T[], weights: readonly number[]): T => {
      let total = 0
      for (let i = 0; i < items.length; i++) total += Math.max(0, weights[i] ?? 0)
      if (total <= 0) return items[Math.floor(next() * items.length)]
      let r = next() * total
      for (let i = 0; i < items.length; i++) {
        r -= Math.max(0, weights[i] ?? 0)
        if (r <= 0) return items[i]
      }
      return items[items.length - 1]
    },
    chance: (p: number) => next() < p,
    get seed() {
      return state >>> 0
    },
  }
  return rng
}

/** Stable id generator (charts, notes, songs) — no crypto dependency required. */
export function createId(prefix: string, seedSource?: string): string {
  const rand = Math.random().toString(36).slice(2, 10)
  const hash = seedSource ? hashString(seedSource).toString(36) : ''
  return `${prefix}_${Date.now().toString(36)}${hash ? `_${hash}` : ''}_${rand}`
}
