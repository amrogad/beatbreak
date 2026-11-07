/**
 * Circle mode placement: turns a chart's timed arrows into circles and sliders on a 512x384 field.
 *
 * The rhythm is the arrow chart's, untouched: same times, same holds. Only the positions are new.
 * The numbers come from human-made maps of the same songs (pulsegrid-testdata, osustd.mjs):
 *  - distance grows with the time gap, and flattens out past one beat;
 *  - harder levels jump on strong beats, easier ones never do;
 *  - turns between moves follow each level's spread of straight, wide and sharp angles;
 *  - repeated bars get the same shape again, mirrored on every other repeat.
 */
import type { Chart, ChartNote, Difficulty } from '../core/types'
import { createRng, hashString, type Rng } from '../core/rng'
import { TimingMap } from './timing'

/**
 * Bump when placement changes where circles go or how many there are: a run's best only counts
 * against runs on the same maps.
 */
export const PLACEMENT_VERSION = 3

export const FIELD_W = 512
export const FIELD_H = 384

export interface CirclePoint {
  x: number
  y: number
}

export interface CircleObject {
  /** The id of the arrow it came from (the first one of a chord). */
  id: string
  time: number
  x: number
  y: number
  kind: 'circle' | 'slider'
  /** Slider end time in seconds (repeats included). */
  endTime: number
  /** Slider path from head to the far end, evenly spaced points in field units. */
  path?: CirclePoint[]
  /** Times the ball runs the path (1 = once, 2 = there and back). */
  slides: number
  /** Number shown on the circle; 1 starts a new combo. */
  number: number
  /** Colour slot, 0-3, changes with every new combo. */
  color: number
  strength: number
}

export interface CircleMap {
  objects: CircleObject[]
  radius: number
  /** How long a circle is on screen before its time. */
  preemptMs: number
  /** Fade-in length at the start of the approach. */
  fadeInMs: number
  /** Radius the cursor must stay inside while following a slider. */
  followRadius: number
}

interface Profile {
  cs: number
  ar: number
  /** Distance in field units for a gap of so many beats (measured on human maps). */
  spacing: [number, number][]
  /** Chance a strong downbeat becomes a jump, and how far. */
  jumpChance: number
  jumpScale: number
  /** Share of straight (<60 deg), wide (60-135) and sharp (>135) turns. */
  turns: [number, number, number]
  sliderPxPerBeat: number
  minSliderBeats: number
  /** Earlier circles closer than this many beats may never be covered by a new one (ranking criteria). */
  clearBeats: number
  /** Room left after a slider before the next circle, in beats. */
  sliderGapBeats: number
  /** Note pairs this many beats apart may become one slider, with this chance. */
  pairBeats: [number, number]
  pairChance: number
  /** How much a bar's loudness stretches its spacing (0 keeps distance snap exact). */
  spread: number
}

/**
 * Human medians (stars: Easy <2, Normal 2-2.8, Hard 2.8-4, Insane 4-5.3): AR 4/5/7/9, distance at
 * 1/2 beat 72/60/70/137 and at 1 beat 96/112/136/150, jumps on 0/0/13/13% of downbeats, sharp
 * turns 9/22/13/35%. Expert here plays like their Insane, a little slower to read (AR 8.5).
 */
const PROFILES: Record<Difficulty, Profile> = {
  easy: { cs: 3, ar: 4, spacing: [[0.25, 40], [0.5, 72], [1, 100], [2, 125]], jumpChance: 0, jumpScale: 1, turns: [0.48, 0.48, 0.04], sliderPxPerBeat: 100, minSliderBeats: 0.5, clearBeats: 1, sliderGapBeats: 0.5, pairBeats: [0.5, 1], pairChance: 0.85, spread: 0 },
  normal: { cs: 3.6, ar: 5, spacing: [[0.25, 36], [0.5, 64], [1, 112], [2, 145]], jumpChance: 0, jumpScale: 1, turns: [0.46, 0.4, 0.14], sliderPxPerBeat: 120, minSliderBeats: 0.5, clearBeats: 1, sliderGapBeats: 0.5, pairBeats: [0.5, 1], pairChance: 0.5, spread: 0.3 },
  hard: { cs: 4, ar: 7, spacing: [[0.25, 30], [0.5, 72], [1, 136], [2, 175]], jumpChance: 0.15, jumpScale: 1.8, turns: [0.5, 0.42, 0.08], sliderPxPerBeat: 140, minSliderBeats: 0.25, clearBeats: 0.5, sliderGapBeats: 0.25, pairBeats: [0.25, 0.5], pairChance: 0.25, spread: 0.4 },
  expert: { cs: 4.2, ar: 8.5, spacing: [[0.25, 40], [0.5, 128], [1, 150], [2, 195]], jumpChance: 0.32, jumpScale: 1.6, turns: [0.3, 0.42, 0.28], sliderPxPerBeat: 180, minSliderBeats: 0.25, clearBeats: 0.25, sliderGapBeats: 0.25, pairBeats: [0.25, 0.5], pairChance: 0.55, spread: 0.45 },
}

export function circleRadius(cs: number): number {
  return 54.4 - 4.48 * cs
}

export function preemptForAr(ar: number): number {
  return ar < 5 ? 1800 - 120 * ar : 1200 - 150 * (ar - 5)
}

/** Keep centres this far inside the field edge. */
const EDGE = 26
/** Within this distance of the field edge a move starts to prefer turning back in. */
const EDGE_SOFT = 70
const MAX_SPAN_PX = 230
const MAX_COMBO = 12

interface Event {
  id: string
  time: number
  beat: number
  strength: number
  /** Hold length in seconds, 0 for a tap. */
  hold: number
}

/** One object per moment: a chord becomes one circle, and its longest hold becomes the slider. */
function toEvents(notes: ChartNote[], timing: TimingMap): Event[] {
  const sorted = [...notes].sort((a, b) => a.time - b.time || a.lane - b.lane)
  const events: Event[] = []
  for (const note of sorted) {
    const last = events[events.length - 1]
    const hold = note.kind === 'hold' ? Math.max(0, note.duration ?? 0) : 0
    if (last && note.time - last.time < 0.012) {
      last.strength = Math.max(last.strength, note.strength)
      last.hold = Math.max(last.hold, hold)
      continue
    }
    events.push({ id: note.id, time: note.time, beat: timing.timeToBeat(note.time), strength: note.strength, hold })
  }
  return events
}

/**
 * Keep the strongest set of objects at least `beats` (and `minSec`) apart. First come first kept
 * would keep an off-beat note and drop the downbeat after it, so the pick weighs each note's
 * strength plus a bonus for sitting on a beat, most for the bar's first beat.
 */
function spaceOut(events: Event[], beats: number, minSec: number, timing: TimingMap): Event[] {
  const n = events.length
  if (n === 0) return []
  const weight = events.map((e) => {
    const inBar = (((e.beat % 4) + 4) % 4)
    const onBeat = Math.abs(inBar - Math.round(inBar)) < 0.06
    // An off-beat note is worth well under half a beat note, so two off-beats never beat the
    // beat between them.
    return 0.5 * e.strength + (onBeat ? 1 : 0.2) + (onBeat && Math.round(inBar) % 4 === 0 ? 0.5 : 0)
  })
  const ends = events.map((e) => ({ beat: timing.timeToBeat(e.time + e.hold), time: e.time + e.hold }))
  // best[i]: the best total of a set that ends with event i; from[i]: the event kept before it.
  const best = new Float64Array(n)
  const from = new Int32Array(n).fill(-1)
  let lastFit = -1
  const prefix: number[] = []
  const prefixAt: number[] = []
  for (let i = 0; i < n; i++) {
    // Every j whose end leaves room before i; ends grow with j for taps and short holds.
    while (lastFit + 1 < i && events[i].beat - ends[lastFit + 1].beat >= beats - 0.02 && events[i].time - ends[lastFit + 1].time >= minSec - 1e-3) {
      lastFit++
      const value = best[lastFit]
      const top = prefix.length ? prefix[prefix.length - 1] : -Infinity
      prefix.push(Math.max(top, value))
      prefixAt.push(value >= top ? lastFit : prefixAt[prefixAt.length - 1])
    }
    const before = prefix.length ? prefix[prefix.length - 1] : 0
    best[i] = weight[i] + Math.max(0, before)
    if (prefix.length) from[i] = prefixAt[prefixAt.length - 1]
  }
  let end = 0
  for (let i = 1; i < n; i++) if (best[i] > best[end]) end = i
  const out: Event[] = []
  for (let i = end; i >= 0; i = from[i]) out.push(events[i])
  return out.reverse()
}

/**
 * Human maps turn many note pairs into one slider: the first note is clicked, the second is where
 * the slider ends. Only a pair whose second note is no louder than the first, with room after it.
 */
function pairSliders(events: Event[], profile: Profile, timing: TimingMap, rng: Rng): Event[] {
  const out: Event[] = []
  for (let i = 0; i < events.length; i++) {
    const a = events[i]
    const b = events[i + 1]
    const c = events[i + 2]
    if (a.hold > 0 || !b || b.hold > 0) {
      out.push(a)
      continue
    }
    const gap = b.beat - a.beat
    const after = c ? c.beat - b.beat : 99
    const fits = gap >= profile.pairBeats[0] - 1e-3 && gap <= profile.pairBeats[1] + 1e-3 && after >= Math.max(gap, profile.sliderGapBeats) - 1e-3
    if (fits && b.strength <= a.strength + 0.15 && rng.chance(profile.pairChance)) {
      out.push({ ...a, hold: timing.beatToTime(b.beat) - a.time })
      i++
      continue
    }
    out.push(a)
  }
  return out
}

function spacingFor(profile: Profile, gapBeats: number): number {
  const table = profile.spacing
  if (gapBeats <= table[0][0]) return Math.max(18, (table[0][1] * gapBeats) / table[0][0])
  for (let i = 1; i < table.length; i++) {
    const [b1, d1] = table[i]
    const [b0, d0] = table[i - 1]
    if (gapBeats <= b1) return d0 + ((d1 - d0) * (gapBeats - b0)) / (b1 - b0)
  }
  return table[table.length - 1][1]
}

const inField = (p: CirclePoint, margin = EDGE): boolean => p.x >= margin && p.x <= FIELD_W - margin && p.y >= margin && p.y <= FIELD_H - margin

/** A gentle bend from `a` towards `b`, as evenly spaced points (arc-length resampled). */
function bendPath(a: CirclePoint, angle: number, length: number, bend: number): CirclePoint[] {
  const b = { x: a.x + Math.cos(angle) * length, y: a.y + Math.sin(angle) * length }
  const mid = { x: (a.x + b.x) / 2 - Math.sin(angle) * bend * length, y: (a.y + b.y) / 2 + Math.cos(angle) * bend * length }
  const raw: CirclePoint[] = []
  const steps = 32
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    raw.push({ x: u * u * a.x + 2 * u * t * mid.x + t * t * b.x, y: u * u * a.y + 2 * u * t * mid.y + t * t * b.y })
  }
  // Scale the curve so its real length matches the wanted one (the bend makes it a little longer).
  let real = 0
  for (let i = 1; i < raw.length; i++) real += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y)
  const k = length / Math.max(1e-6, real)
  const scaled = raw.map((p) => ({ x: a.x + (p.x - a.x) * k, y: a.y + (p.y - a.y) * k }))
  return resample(scaled, Math.max(2, Math.round(length / 6)))
}

function resample(points: CirclePoint[], count: number): CirclePoint[] {
  const cum = [0]
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y))
  const total = cum[cum.length - 1]
  const out: CirclePoint[] = []
  let j = 1
  for (let i = 0; i <= count; i++) {
    const target = (total * i) / count
    while (j < points.length - 1 && cum[j] < target) j++
    const span = cum[j] - cum[j - 1] || 1
    const t = Math.max(0, Math.min(1, (target - cum[j - 1]) / span))
    out.push({ x: points[j - 1].x + (points[j].x - points[j - 1].x) * t, y: points[j - 1].y + (points[j].y - points[j - 1].y) * t })
  }
  return out
}

/** Where a slider's ball is at a time; ping-pongs on repeats. */
export function sliderBall(object: CircleObject, timeSec: number): CirclePoint {
  const path = object.path
  if (!path || path.length < 2 || object.endTime <= object.time) return { x: object.x, y: object.y }
  const span = (object.endTime - object.time) / object.slides
  const elapsed = Math.max(0, Math.min(object.endTime - object.time, timeSec - object.time))
  const pass = Math.min(object.slides - 1, Math.floor(elapsed / span))
  let progress = (elapsed - pass * span) / span
  if (pass % 2 === 1) progress = 1 - progress
  const f = progress * (path.length - 1)
  const i = Math.min(path.length - 2, Math.floor(f))
  const t = f - i
  return { x: path[i].x + (path[i + 1].x - path[i].x) * t, y: path[i].y + (path[i + 1].y - path[i].y) * t }
}

/** Where the cursor leaves a slider: the far end after an odd number of runs, the head after an even one. */
export function sliderExit(object: CircleObject): CirclePoint {
  if (object.kind !== 'slider' || !object.path) return { x: object.x, y: object.y }
  return object.slides % 2 === 1 ? object.path[object.path.length - 1] : object.path[0]
}

interface Placed {
  x: number
  y: number
  time: number
  endTime: number
}

/** Bar fingerprint: where in the bar each object sits and how long it holds, in 1/12 beats. */
function barSignature(events: Event[], timing: TimingMap): string {
  return events.map((e) => `${Math.round((((e.beat % 4) + 4) % 4) * 12)}:${e.hold > 0 ? Math.round((timing.timeToBeat(e.time + e.hold) - e.beat) * 4) : 0}`).join(',')
}

/**
 * Which arrow chart a circle difficulty takes its rhythm from. Every circle needs aim as well as
 * timing, so human osu! maps play far fewer objects than arrow charts of the same name: measured
 * on 24 songs, our arrow Easy/Normal/Hard as circles came to 1.0/1.9/3.1 objects a second against
 * human 0.8/1.2/1.9/2.8 for Easy to Insane. One tier down lands on the human numbers.
 */
export const CIRCLE_RHYTHM: Record<Difficulty, Difficulty> = { easy: 'easy', normal: 'easy', hard: 'normal', expert: 'hard' }

/** The arrow chart circles of this chart's difficulty are placed from (the chart itself if missing). */
export function circleRhythm<T extends Pick<Chart, 'difficulty'>>(charts: readonly T[], chart: T): T {
  return charts.find((candidate) => candidate.difficulty === CIRCLE_RHYTHM[chart.difficulty]) ?? chart
}

/** Easy circles keep at least this many beats between objects (human Easy maps: never under 1/2). */
const EASY_MIN_GAP_BEATS = 1
/** ...and this much time, so a fast song's Easy does not ask for a click every 300 ms. */
const EASY_MIN_GAP_SEC = 0.45
/**
 * Fastest the pointer is asked to travel, in field px per second. Spacing is set in beats, so a
 * fast song would otherwise ask for jumps only a good player can make on a level called Hard.
 */
const MAX_SPEED: Record<Difficulty, number> = { easy: 450, normal: 600, hard: 800, expert: 1100 }
/**
 * Slider ball speed and shortest slider, in seconds rather than beats: on a fast song (or one read
 * at double tempo) a slider sized in beats sent the ball flying (Amro, Blue - All Rise at 196 BPM).
 */
const MAX_SLIDER_SPEED: Record<Difficulty, number> = { easy: 170, normal: 230, hard: 300, expert: 400 }
const MIN_SLIDER_SEC: Record<Difficulty, number> = { easy: 0.45, normal: 0.35, hard: 0.25, expert: 0.2 }

export function placeCircles(
  chart: Pick<Chart, 'id' | 'difficulty' | 'notes' | 'timing'>,
  rhythm: Pick<Chart, 'notes' | 'timing'> = chart,
): CircleMap {
  const profile = PROFILES[chart.difficulty] ?? PROFILES.normal
  const radius = circleRadius(profile.cs)
  const preemptMs = preemptForAr(profile.ar)
  const timing = new TimingMap(rhythm.timing)
  const rng = createRng(hashString(`${chart.id}|circles`))
  let raw = toEvents(rhythm.notes, timing)
  if (chart.difficulty === 'easy') raw = spaceOut(raw, EASY_MIN_GAP_BEATS, EASY_MIN_GAP_SEC, timing)
  const events = pairSliders(raw, profile, timing, rng)
  const objects: CircleObject[] = []
  const placed: Placed[] = []

  let heading = rng.range(-0.4, 0.4)
  let spin: 1 | -1 = rng.chance(0.5) ? 1 : -1
  let patternTurn = 0
  let combo = 0
  let color = 0
  let lastBar = -1
  // Coarse visit map (4x3) so the whole field gets used over a song, not one corner.
  const heat = new Float32Array(12)
  const bars = new Map<string, { start: number; offsets: CirclePoint[]; used: number }>()
  let barStartIndex = 0
  let barTransform: { ref: CirclePoint[]; mirror: number; origin: CirclePoint } | null = null
  let barScale = 1
  const meanStrength = events.reduce((sum, e) => sum + e.strength, 0) / Math.max(1, events.length)

  const pickTurn = (): number => {
    const [straight, wide] = profile.turns
    const r = rng.next()
    const deg = r < straight ? rng.range(10, 55) : r < straight + wide ? rng.range(65, 125) : rng.range(140, 170)
    return (deg * Math.PI) / 180
  }

  /** Penalty for covering a recent circle; the one just before is exempt (its spacing is the move itself). */
  const clearOf = (p: CirclePoint, time: number): number => {
    const beatSec = timing.secondsPerBeat(timing.timeToBeat(time))
    let penalty = 0
    for (let k = placed.length - 2; k >= 0; k--) {
      const q = placed[k]
      if (time - q.endTime > profile.clearBeats * beatSec + 1e-3) break
      const d = Math.hypot(p.x - q.x, p.y - q.y)
      if (d < radius * 2.1) penalty += 3 * (1 - d / (radius * 2.1)) + 1
    }
    return penalty
  }

  const heatAt = (p: CirclePoint): number => heat[Math.min(2, Math.floor((p.y / FIELD_H) * 3)) * 4 + Math.min(3, Math.floor((p.x / FIELD_W) * 4))]
  const warm = (p: CirclePoint): void => {
    for (let i = 0; i < heat.length; i++) heat[i] *= 0.93
    heat[Math.min(2, Math.floor((p.y / FIELD_H) * 3)) * 4 + Math.min(3, Math.floor((p.x / FIELD_W) * 4))] += 1
  }

  /** Best spot near `want` at distance ~d from `from`: in bounds, clear of recent circles, on a fresh part of the field. */
  const choose = (from: CirclePoint, wantAngle: number, d: number, time: number, exact: boolean): { p: CirclePoint; angle: number } => {
    let best: { p: CirclePoint; angle: number; score: number } | null = null
    const scales = exact ? [1, 0.94, 1.06] : [1, 0.92, 1.08, 0.8]
    for (const scale of scales) {
      for (let k = 0; k <= 36; k++) {
        const off = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 18)
        const angle = wantAngle + off
        const p = { x: from.x + Math.cos(angle) * d * scale, y: from.y + Math.sin(angle) * d * scale }
        if (!inField(p)) continue
        // The edge only pushes back near the edge: a pull to the centre everywhere bent every move
        // and made the turns feel random.
        const edge = Math.min(p.x, FIELD_W - p.x, p.y, FIELD_H - p.y)
        const nearEdge = edge < EDGE_SOFT ? (1 - edge / EDGE_SOFT) * 0.5 : 0
        const score = Math.abs(off) / Math.PI + Math.abs(scale - 1) * 1.5 + clearOf(p, time) + heatAt(p) * 0.01 + nearEdge
        if (!best || score < best.score) best = { p, angle, score }
      }
      if (best && best.score < 0.6) break
    }
    if (best) return best
    const p = { x: Math.max(EDGE, Math.min(FIELD_W - EDGE, from.x)), y: Math.max(EDGE, Math.min(FIELD_H - EDGE, from.y)) }
    return { p, angle: wantAngle }
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    const next = events[i + 1]
    const bar = Math.floor(event.beat / 4 + 1e-6)
    const beatInBar = event.beat - bar * 4
    const beatSec = timing.secondsPerBeat(event.beat)
    const prev = placed[placed.length - 1]

    // New bar: a fresh pattern turn, sometimes the other way round, and maybe a known shape.
    if (bar !== lastBar) {
      lastBar = bar
      patternTurn = pickTurn()
      // Keep turning the same way through a phrase (8 bars); flipping every bar read as random.
      if (bar % 8 === 0 && rng.chance(0.5)) spin = spin === 1 ? -1 : 1
      barStartIndex = objects.length
      barTransform = null
      let end = i
      while (end < events.length && Math.floor(events[end].beat / 4 + 1e-6) === bar) end++
      const barEvents = events.slice(i, end)
      const loud = barEvents.reduce((sum, e) => sum + e.strength, 0) / Math.max(1, barEvents.length) - meanStrength
      barScale = Math.max(0.88, Math.min(1.15, 1 + profile.spread * 0.5 * (loud * 2 + rng.range(-0.1, 0.1))))
      const signature = barEvents.length >= 3 ? barSignature(barEvents, timing) : ''
      const known = signature ? bars.get(signature) : undefined
      if (known && known.offsets.length === barEvents.length) {
        known.used++
        barTransform = { ref: known.offsets, mirror: known.used % 2 === 1 ? -1 : 1, origin: { x: 0, y: 0 } }
      } else if (signature) {
        bars.set(signature, { start: barStartIndex, offsets: [], used: 0 })
      }
      if (combo >= 4 || (prev && event.time - prev.endTime > 2 * beatSec)) {
        combo = 0
        color = (color + 1) % 4
      }
    }
    if (combo >= MAX_COMBO || (prev && event.time - prev.endTime > 2 * beatSec)) {
      combo = 0
      color = (color + 1) % 4
    }

    // Slider length: the hold, cut so the next object is never rushed.
    let holdSec = event.hold
    if (holdSec > 0 && next) holdSec = Math.min(holdSec, next.time - event.time - Math.max(profile.sliderGapBeats * beatSec, 0.1))
    const holdBeats = holdSec > 0 ? timing.timeToBeat(event.time + holdSec) - event.beat : 0
    const isSlider = holdBeats >= profile.minSliderBeats - 1e-6 && holdSec >= (MIN_SLIDER_SEC[chart.difficulty] ?? 0.3)

    let pos: CirclePoint
    if (!prev) {
      pos = { x: FIELD_W / 2 + rng.range(-90, 90), y: FIELD_H / 2 + rng.range(-50, 50) }
    } else {
      const from = { x: prev.x, y: prev.y }
      const gapBeats = Math.max(0.05, (event.time - prev.endTime) / beatSec)
      const onBeat = Math.abs(beatInBar - Math.round(beatInBar)) < 0.06
      const downbeat = onBeat && Math.round(beatInBar) % 4 === 0
      // Same gap, same distance inside a bar: players read the rhythm from the spacing.
      let d = spacingFor(profile, gapBeats) * barScale
      const accent = onBeat ? (downbeat ? 1 : event.strength >= 0.85 ? 0.33 : 0) : event.strength >= 0.85 ? 0.3 : 0
      if (profile.jumpChance > 0 && gapBeats >= 0.45 && accent > 0 && rng.chance(profile.jumpChance * accent)) d *= profile.jumpScale
      // Harder levels stack the first two notes of a quick burst on one spot now and then.
      const prevGap = placed.length >= 2 ? (prev.time - placed[placed.length - 2].endTime) / beatSec : 99
      const stacked = profile.jumpChance > 0 && gapBeats <= 0.26 && prevGap >= 0.45 && rng.chance(0.35)
      if (stacked) d = 0
      d = Math.min(d, (MAX_SPEED[chart.difficulty] ?? MAX_SPEED.normal) * Math.max(0.05, event.time - prev.endTime))
      // Short gaps (streams) curve gently; everything else follows the bar's pattern turn.
      const turn = gapBeats <= 0.3 ? rng.range(0.15, 0.35) : patternTurn + rng.range(-0.06, 0.06)
      let want = heading + spin * turn
      const exactDistance = profile.jumpChance === 0
      const shapeIndex = objects.length - barStartIndex
      if (barTransform && shapeIndex > 0 && shapeIndex < barTransform.ref.length) {
        // A repeated bar: same moves as last time, mirrored on every other repeat.
        const ref = barTransform.ref
        const dx = ref[shapeIndex].x - ref[shapeIndex - 1].x
        const dy = ref[shapeIndex].y - ref[shapeIndex - 1].y
        const target = { x: from.x + dx * barTransform.mirror, y: from.y + dy }
        if (inField(target) && clearOf(target, event.time) === 0) {
          pos = target
          heading = Math.atan2(dy, dx * barTransform.mirror)
        } else {
          barTransform = null
          const pick = choose(from, want, d, event.time, exactDistance)
          pos = pick.p
          heading = pick.angle
        }
      } else if (stacked) {
        // A stack sits a little up and left of the circle under it, so both stay visible.
        pos = { x: Math.max(EDGE, from.x - radius * 0.18), y: Math.max(EDGE, from.y - radius * 0.18) }
      } else {
        if (d < 4) want = heading
        const pick = choose(from, want, d, event.time, exactDistance)
        pos = pick.p
        if (Math.hypot(pos.x - from.x, pos.y - from.y) > 4) heading = Math.atan2(pos.y - from.y, pos.x - from.x)
      }
    }

    // Whatever picked the spot (a repeated shape, a jump, a nudge off a recent circle), the move
    // stays under the level's pointer speed.
    if (prev) {
      const maxD = (MAX_SPEED[chart.difficulty] ?? MAX_SPEED.normal) * Math.max(0.05, event.time - prev.endTime)
      const dist = Math.hypot(pos.x - prev.x, pos.y - prev.y)
      if (dist > maxD) pos = { x: prev.x + ((pos.x - prev.x) * maxD) / dist, y: prev.y + ((pos.y - prev.y) * maxD) / dist }
    }

    let path: CirclePoint[] | undefined
    let slides = 1
    let endPoint = pos
    if (isSlider) {
      const total = Math.min(profile.sliderPxPerBeat * holdBeats, (MAX_SLIDER_SPEED[chart.difficulty] ?? 250) * holdSec)
      slides = Math.max(1, Math.ceil(total / MAX_SPAN_PX))
      const spanLen = Math.max(radius * 0.9, total / slides)
      const bend = (spin * rng.range(0.12, 0.3)) as number
      let bestPath: CirclePoint[] | null = null
      for (let k = 0; k <= 24 && !bestPath; k++) {
        const angle = heading + spin * 0.5 + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 12)
        const candidate = bendPath(pos, angle, spanLen, bend)
        if (candidate.every((p) => inField(p, EDGE - 6)) && clearOf(candidate[candidate.length - 1], event.time + holdSec) < 1) bestPath = candidate
      }
      if (!bestPath) {
        for (let k = 0; k < 24 && !bestPath; k++) {
          const candidate = bendPath(pos, (k * Math.PI) / 12, spanLen * 0.6, bend)
          if (candidate.every((p) => inField(p, EDGE - 6))) bestPath = candidate
        }
      }
      if (bestPath) {
        path = bestPath
        endPoint = slides % 2 === 1 ? path[path.length - 1] : path[0]
        const tail = path[path.length - 1]
        const before = path[Math.max(0, path.length - 3)]
        heading = slides % 2 === 1 ? Math.atan2(tail.y - before.y, tail.x - before.x) : heading + Math.PI
      }
    }

    combo++
    const object: CircleObject = {
      id: event.id,
      time: event.time,
      x: Math.round(pos.x * 10) / 10,
      y: Math.round(pos.y * 10) / 10,
      kind: path ? 'slider' : 'circle',
      endTime: path ? event.time + holdSec : event.time,
      slides,
      number: combo,
      color,
      strength: event.strength,
    }
    if (path) object.path = path
    objects.push(object)
    placed.push({ x: endPoint.x, y: endPoint.y, time: event.time, endTime: object.endTime })
    if (path) placed.splice(placed.length - 1, 0, { x: pos.x, y: pos.y, time: event.time, endTime: event.time })
    warm(pos)

    // Remember this bar's shape the first time it is played, for its repeats.
    const shapeIndex = objects.length - 1 - barStartIndex
    if (!barTransform) {
      for (const entry of bars.values()) {
        if (entry.start === barStartIndex && entry.offsets.length === shapeIndex) entry.offsets.push({ x: pos.x, y: pos.y })
      }
    }
  }
  return { objects, radius, preemptMs, fadeInMs: (preemptMs * 2) / 3, followRadius: radius * 2.4 }
}
