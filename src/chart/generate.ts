/**
 * Automatic chart generation.
 *
 * Input: an analysis result + a timing map. Output: a playable four-lane chart.
 *
 * The generator is structured as explicit stages so each one can be tested, replaced or improved
 * independently:
 *
 *   1. candidate selection   — which onsets are worth turning into notes (per difficulty)
 *   2. grid quantization     — snap candidates onto the timing grid, discard the unreliable
 *   3. density shaping       — per-phrase budget driven by song structure and onset strength
 *   4. lane assignment       — motif-driven pattern engine with playability constraints
 *   5. statistics + rating   — note count, NPS, difficulty rating
 *
 * Every stage is deterministic given a seed, so regenerating with the same settings reproduces
 * the same chart exactly.
 */
import { ANCHOR_LIMIT, anchorWindow, applyChartRules } from './rules'
import { BAR_BEATS, groupBars, type BarGroups } from './structure'
import type {
  AnalysisResult,
  Chart,
  ChartNote,
  ChartStats,
  Difficulty,
  Lane,
  OnsetEvent,
  Section,
} from '../core/types'
import { DIFFICULTIES, LANES } from '../core/types'
import { clamp, quantile } from '../core/math'
import { createRng, createId, hashString, type Rng } from '../core/rng'
import { isCut, type EditPlan } from '../core/edit'
import { TimingMap, sortNotes } from './timing'

export const GENERATOR_VERSION = 'pulsegrid-gen-4.3'

/** Hits this close to an eighth snap to it instead of the nearest 16th (Hard and Expert). */
const COARSE_SNAP_MS = 55

/**
 * Per-difficulty behaviour. `stepsPerBeat` is the grid resolution the difficulty snaps to
 * (2 = eighth notes, 4 = sixteenth notes); `keepRatio` caps how much of the available onsets can
 * become notes (keeps charts musical instead of turning every transient into an arrow).
 */
export interface DifficultyProfile {
  stepsPerBeat: number
  /** Onsets further than this from a grid step are discarded (ms). */
  snapToleranceMs: number
  /** Maximum fraction of detected onsets turned into notes. */
  keepRatio: number
  /** Target notes per second (the primary density control). */
  targetNps: number
  /** Maximum simultaneous notes. */
  maxChord: number
  /** Minimum time between two notes in the same lane (s). */
  minJackGap: number
  /** Minimum time between any two notes (s) — prevents impossible walls of notes. */
  minGap: number
  /** Onsets below this strength quantile are ignored. */
  strengthFloor: number
  /** Higher = only the loudest hits survive the density budget. */
  accent: number
  /** Preference for candidates that sit exactly on a beat. */
  onBeatBonus: number
}

/**
 * Difficulty is mostly a *count and pace* decision for a normal player:
 *
 *   easy    one arrow at a time, on the beat, roughly one every two beats
 *   normal  a steady single-arrow stream on eighths
 *   hard    eighth-note flow with occasional two-arrow jumps
 *   expert  the full 1:1 chart, with rare three- and four-arrow accents
 *
 * Densities were raised on 2026-11-07 toward human charts of the same songs (StepMania and
 * osu!mania): on 15 songs Easy/Normal/Hard now play 27/45/58% of a human chart's moments (was
 * 22/36/54%) with the same share of our arrows landing on theirs (84/83/79%).
 *
 * Chords are gated by genuine simultaneous multi-band hits, a strong grid position, a strength
 * threshold and a long recovery gap. Hard never asks for more than two arrows at once; Expert
 * earns a hand only on a real downbeat accent, at most once every few bars.
 */
export const DIFFICULTY_PROFILES: Record<Difficulty, DifficultyProfile> = {
  easy: {
    stepsPerBeat: 1,
    snapToleranceMs: 70,
    keepRatio: 0.9,
    targetNps: 2.2,
    maxChord: 1,
    minJackGap: 0.4,
    minGap: 0.3,
    strengthFloor: 0.28,
    accent: 1.35,
    onBeatBonus: 0.55,
  },
  normal: {
    stepsPerBeat: 2,
    snapToleranceMs: 65,
    keepRatio: 0.9,
    targetNps: 3.2,
    maxChord: 1,
    minJackGap: 0.28,
    minGap: 0.2,
    strengthFloor: 0.12,
    accent: 1.2,
    onBeatBonus: 0.38,
  },
  hard: {
    stepsPerBeat: 4,
    snapToleranceMs: 55,
    keepRatio: 1,
    targetNps: 4.5,
    maxChord: 2,
    minJackGap: 0.18,
    minGap: 0.12,
    strengthFloor: 0.15,
    accent: 1.1,
    onBeatBonus: 0.22,
  },
  expert: {
    // The full chart: `targetNps` is deliberately high and `keepRatio` is 1, so the per-phrase
    // budget is "every candidate" — this is the 1:1 tier where arrows track the music's notes.
    // Only noise (the bottom of the strength floor) and physical lane constraints remove notes.
    stepsPerBeat: 4,
    snapToleranceMs: 45,
    keepRatio: 1,
    targetNps: 24,
    maxChord: 4,
    minJackGap: 0.11,
    minGap: 0.075,
    strengthFloor: 0.05,
    accent: 0.95,
    onBeatBonus: 0.1,
  },
}

/** Lane patterns the sequencer follows. Motifs are what make charts feel authored, not random. */
export interface Motif {
  id: string
  /** Lane cycle used for single notes. */
  lanes: Lane[]
  /** Two-note chord shapes this motif prefers. */
  chords: [Lane, Lane][]
  tags: ('smooth' | 'dense' | 'bright' | 'kick' | 'jumpy' | 'techy')[]
  /** Rough density multiplier when scoring motif suitability. */
  density: number
}

export const MOTIFS: Motif[] = [
  { id: 'stair-up', lanes: [0, 1, 2, 3], chords: [[0, 3], [1, 2]], tags: ['smooth', 'dense'], density: 1 },
  { id: 'stair-down', lanes: [3, 2, 1, 0], chords: [[1, 2], [0, 3]], tags: ['smooth', 'dense'], density: 1 },
  { id: 'zigzag', lanes: [0, 3, 1, 2], chords: [[0, 3], [1, 2]], tags: ['jumpy', 'techy'], density: 1.05 },
  { id: 'trill-outer', lanes: [0, 3, 0, 3], chords: [[0, 3]], tags: ['kick', 'techy'], density: 1.1 },
  { id: 'trill-inner', lanes: [1, 2, 1, 2], chords: [[1, 2]], tags: ['kick', 'techy'], density: 1.1 },
  { id: 'arc', lanes: [0, 1, 2, 1], chords: [[0, 3], [1, 2]], tags: ['smooth'], density: 0.9 },
  { id: 'arc-out', lanes: [3, 2, 1, 2], chords: [[0, 3]], tags: ['smooth'], density: 0.9 },
  { id: 'spiral', lanes: [0, 3, 1, 2, 0, 3], chords: [[0, 2], [1, 3]], tags: ['techy', 'jumpy'], density: 1.1 },
  { id: 'snap-back', lanes: [2, 3, 1, 0], chords: [[0, 1], [2, 3]], tags: ['bright', 'jumpy'], density: 1.05 },
  { id: 'out-in', lanes: [0, 3, 2, 1], chords: [[0, 3], [1, 2]], tags: ['bright'], density: 1 },
  { id: 'pulse', lanes: [1, 0, 2, 3], chords: [[0, 3]], tags: ['kick'], density: 0.85 },
  { id: 'double-step', lanes: [0, 2, 1, 3], chords: [[0, 2], [1, 3]], tags: ['dense', 'techy'], density: 1.15 },
]

export interface GenerationSettings {
  stepsPerBeat: number
  keepRatio: number
  targetNps: number
  maxChord: number
  minJackGap: number
  minGap: number
  strengthFloor: number
  accent: number
  onBeatBonus: number
  snapToleranceMs: number
}

export interface GenerateOptions {
  seed?: number
  /** Changes the variation while keeping the same song: used by "New arrows". */
  salt?: number
  overrides?: Partial<GenerationSettings>
}

/** A quantized candidate before lane assignment. */
export interface Candidate {
  step: number
  /** Playback time: the grid step, or a triplet for a strong off-grid hit. */
  time: number
  /** Detected attack time of the strongest hit on this step. */
  attack: number
  strength: number
  band: number
  brightness: number
  /** Number of raw onsets that landed on this step (a chord-worthy hit). */
  hits: number
  /** Raw onset times merged onto this step, kept so chord gating only uses true hits together. */
  hitTimes: number[]
  /** Spectral band of each entry in `hitTimes`. */
  hitBands: number[]
  /** Hits within 45 ms of the strongest hit: a real simultaneous accent, not a fast roll. */
  simultaneousHits: number
  /** Distinct bands among the simultaneous hits. */
  bands: number[]
  section: Section | null
  /**
   * Longest sustained sound on this step, in seconds, when the analysis measured one. This is
   * what `applyHolds` turns into hold length — undefined when the analysis predates the field.
   */
  heldSeconds?: number
  /** Group and slot this note belongs to: the same pattern gets the same arrows every time. */
  pattern?: string
  /** This bar takes its group's arrows flipped left to right. */
  mirrored?: boolean
}

export interface SelectionDiagnostics {
  rawOnsets: number
  kept: number
  droppedOffGrid: number
  droppedFloor: number
  droppedOffGridWeak: number
  droppedSilence: number
  densityPerSecond: number
}

export interface SelectionResult {
  candidates: Candidate[]
  diagnostics: SelectionDiagnostics
}

export function sectionAt(sections: Section[], time: number): Section | null {
  let best: Section | null = null
  for (const section of sections) {
    if (time >= section.start && time < section.end) best = section
  }
  return best
}

/** Merge a difficulty profile with explicit overrides. */
export function resolveSettings(
  difficulty: Difficulty,
  overrides: Partial<GenerationSettings> = {},
): GenerationSettings {
  const profile = DIFFICULTY_PROFILES[difficulty]
  return {
    stepsPerBeat: overrides.stepsPerBeat ?? profile.stepsPerBeat,
    keepRatio: overrides.keepRatio ?? profile.keepRatio,
    targetNps: overrides.targetNps ?? profile.targetNps,
    maxChord: overrides.maxChord ?? profile.maxChord,
    minJackGap: overrides.minJackGap ?? profile.minJackGap,
    minGap: overrides.minGap ?? profile.minGap,
    strengthFloor: overrides.strengthFloor ?? profile.strengthFloor,
    accent: overrides.accent ?? profile.accent,
    onBeatBonus: overrides.onBeatBonus ?? profile.onBeatBonus,
    snapToleranceMs: overrides.snapToleranceMs ?? profile.snapToleranceMs,
  }
}

/* ----------------------------------------------------------------------------------------- */
/* Stage 1 + 2: candidate selection and grid quantization                                    */
/* ----------------------------------------------------------------------------------------- */

export function selectCandidates(
  analysis: Pick<AnalysisResult, 'onsets' | 'sections' | 'silentRegions'>,
  timing: TimingMap,
  duration: number,
  settings: GenerationSettings,
): SelectionResult {
  const onsets: OnsetEvent[] = analysis.onsets.filter(
    (o) => Number.isFinite(o.time) && o.time >= 0 && o.time < duration,
  )
  const floor = quantile(
    onsets.map((o) => o.strength),
    clamp(settings.strengthFloor, 0, 0.9),
  )

  // Quiet passages (an intro pad, a breakdown) sit under the song-wide floor and used to come out
  // completely empty — the "twenty seconds before the first arrow" complaint. Give every short
  // window its own, looser floor so quiet music still earns sparse notes without lowering the bar
  // anywhere else.
  const QUIET_WINDOW_SECONDS = 4
  const windowCount = Math.max(1, Math.ceil(duration / QUIET_WINDOW_SECONDS))
  const strengthsByWindow: number[][] = Array.from({ length: windowCount }, () => [])
  for (const onset of onsets) {
    const window = clamp(Math.floor(onset.time / QUIET_WINDOW_SECONDS), 0, windowCount - 1)
    strengthsByWindow[window].push(onset.strength)
  }
  const localQuantile = clamp(settings.strengthFloor * 0.6, 0, 0.9)
  const localFloors = strengthsByWindow.map((windowStrengths) =>
    windowStrengths.length >= 3 ? quantile(windowStrengths, localQuantile) : Number.POSITIVE_INFINITY,
  )
  const floorAt = (time: number): number =>
    Math.min(floor, localFloors[clamp(Math.floor(time / QUIET_WINDOW_SECONDS), 0, windowCount - 1)])

  const isSilent = (t: number): boolean =>
    analysis.silentRegions.some((region) => t >= region.start - 0.05 && t <= region.end + 0.05)

  const byStep = new Map<number, Candidate>()
  let droppedFloor = 0
  let droppedOffGrid = 0
  let droppedOffGridWeak = 0
  let droppedSilence = 0
  // Every difficulty snaps to the fitted grid. Detected attack times scatter by 20-30 ms on a
  // good share of hits (a hat under a decaying kick, reverb tails), so raw times made Hard and
  // Expert streams uneven and put the same sound at different times on different difficulties.
  // Strong off-grid hits on the 16th-note charts snap to the triplet grid instead, or are dropped.
  const fineGrid = settings.stepsPerBeat >= 4
  const TRIPLET_TOLERANCE_MS = 25

  for (const onset of onsets) {
    if (onset.strength + 1e-9 < floorAt(onset.time)) {
      droppedFloor++
      continue
    }
    if (isSilent(onset.time)) {
      droppedSilence++
      continue
    }
    let step = Math.round(timing.timeToBeat(onset.time) * settings.stepsPerBeat)
    // A hit close to an eighth goes on the eighth: attacks are often detected a little early, and
    // snapping those to the 16th before put arrows where human charts never do. Against the human
    // StepMania and osu! charts of the same songs this raised Hard/Expert arrows that both humans
    // also chart from 62-66% to 66-72%.
    if (fineGrid && step % (settings.stepsPerBeat / 2) !== 0) {
      const half = settings.stepsPerBeat / 2
      const eighth = Math.round(timing.timeToBeat(onset.time) * 2) * half
      if (Math.abs(timing.stepToTime(eighth, settings.stepsPerBeat) - onset.time) * 1000 <= COARSE_SNAP_MS) step = eighth
    }
    if (step < 0) {
      droppedOffGrid++
      continue
    }
    const stepTime = timing.stepToTime(step, settings.stepsPerBeat)
    const deltaMs = Math.abs(stepTime - onset.time) * 1000
    let noteTime = stepTime
    if (deltaMs > settings.snapToleranceMs) {
      // Too far from the grid to trust: keep only clearly strong hits that sit on a triplet, and
      // only when the difficulty uses a fine enough grid to represent them.
      const strongSyncopation = fineGrid && onset.strength >= Math.max(floor + 0.15, 0.6)
      const tripletTime = timing.stepToTime(Math.round(timing.timeToBeat(onset.time) * 6), 6)
      if (!strongSyncopation || Math.abs(tripletTime - onset.time) * 1000 > TRIPLET_TOLERANCE_MS) {
        droppedOffGridWeak++
        continue
      }
      noteTime = tripletTime
    }
    const existing = byStep.get(step)
    if (existing) {
      existing.hits++
      existing.hitTimes.push(onset.time)
      existing.hitBands.push(onset.band)
      if (onset.strength > existing.strength) {
        existing.strength = onset.strength
        existing.band = onset.band
        existing.brightness = onset.brightness
        existing.time = noteTime
        existing.attack = onset.time
      }
      if (onset.heldSeconds !== undefined) {
        existing.heldSeconds = Math.max(existing.heldSeconds ?? 0, onset.heldSeconds)
      }
      continue
    }
    byStep.set(step, {
      step,
      time: noteTime,
      attack: onset.time,
      strength: onset.strength,
      band: onset.band,
      brightness: onset.brightness,
      hits: 1,
      hitTimes: [onset.time],
      hitBands: [onset.band],
      simultaneousHits: 1,
      bands: [onset.band],
      section: sectionAt(analysis.sections, onset.time),
      heldSeconds: onset.heldSeconds,
    })
  }

  const candidates = [...byStep.values()].sort((a, b) => a.step - b.step)
  // Chord-worthy means the sounds really arrive together. A kick followed 80 ms later by a hat
  // can share a 16th step at 128 BPM, but that is a flam, not a jump; stacking both on one frame
  // is what produced awkward generated hands. Count only hits inside the simultaneity window and
  // require more than one spectral band.
  const CHORD_SIMULTANEOUS_SECONDS = 0.045
  for (const candidate of candidates) {
    let simultaneousHits = 0
    const bands = new Set<number>()
    for (let i = 0; i < candidate.hitTimes.length; i++) {
      if (Math.abs(candidate.hitTimes[i] - candidate.attack) > CHORD_SIMULTANEOUS_SECONDS) continue
      simultaneousHits++
      bands.add(candidate.hitBands[i])
    }
    candidate.simultaneousHits = Math.max(1, simultaneousHits)
    candidate.bands = [...bands]
  }

  return {
    candidates,
    diagnostics: {
      rawOnsets: onsets.length,
      kept: candidates.length,
      droppedOffGrid,
      droppedFloor,
      droppedOffGridWeak,
      droppedSilence,
      densityPerSecond: candidates.length / Math.max(0.001, duration),
    },
  }
}

/* ----------------------------------------------------------------------------------------- */
/* Stage 3: density shaping                                                                  */
/* ----------------------------------------------------------------------------------------- */

const ENERGY_SENSITIVITY: Record<Difficulty, number> = { easy: 0.5, normal: 0.8, hard: 1.1, expert: 1.3 }

/** Budget multiplier per detected section type. */
const SECTION_DENSITY: Record<Section['kind'], number> = {
  silent: 0,
  sparse: 0.55,
  build: 0.9,
  groove: 1,
  peak: 1.16,
}

/** What the song's repeats need to know about the rest of the analysis. */
export interface SongStructure {
  groups: BarGroups
  sections: Section[]
  isSilent: (time: number) => boolean
}

/** A slot needs at least this share of its group's bars before the group adopts it. */
const MIN_SLOT_PRESENCE = 0.34
/** A slot this common in a group of at least FILL_MIN_BARS is written into every bar of the group. */
const FILL_SLOT_PRESENCE = 0.6
const FILL_MIN_BARS = 3

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/**
 * Decides the rhythm once per group of matching bars, from what the group agrees on, and writes
 * the same rhythm into every bar of the group. A bar that matches nothing is a group of one.
 */
export function shapeDensity(
  candidates: Candidate[],
  timing: TimingMap,
  duration: number,
  settings: GenerationSettings,
  difficulty: Difficulty,
  structure: SongStructure,
): Candidate[] {
  if (candidates.length === 0) return []
  const { groups, sections, isSilent } = structure
  const strengths = candidates.map((c) => c.strength)
  const strongThreshold = quantile(strengths, 0.75)
  const songDensity = candidates.length / Math.max(1, duration)
  const densityScale = clamp(songDensity / 3.2, 0.72, 1.45)
  const stepsPerBar = Math.max(1, Math.round(BAR_BEATS * settings.stepsPerBeat))

  const byBar = new Map<number, Candidate[]>()
  for (const candidate of candidates) {
    const bar = Math.floor(candidate.step / stepsPerBar)
    const list = byBar.get(bar)
    if (list) list.push(candidate)
    else byBar.set(bar, [candidate])
  }

  const barBudget = (bar: number, inBar: Candidate[]): number => {
    const barStart = timing.beatToTime(bar * BAR_BEATS)
    const barEnd = timing.beatToTime((bar + 1) * BAR_BEATS)
    const snapshotSections = inBar.map((c) => c.section).filter((s): s is Section => s !== null)
    const section = snapshotSections.length > 0 ? sectionAt(dedupeSections(snapshotSections), (barStart + barEnd) / 2) : null
    const sectionKind = section?.kind ?? 'groove'
    if (sectionKind === 'silent') return 0
    const energyScale = clamp(1 + ((section?.energy ?? 0.5) - 0.5) * ENERGY_SENSITIVITY[difficulty], 0.7, 1.35)
    const barSeconds = Math.max(0.05, barEnd - barStart)
    const budgetByTime = barSeconds * settings.targetNps * densityScale * energyScale * SECTION_DENSITY[sectionKind]
    const budgetByOnsets = inBar.length * settings.keepRatio
    // A quiet passage should breathe, but it must not collapse an Easy chart into one arrow every
    // three seconds: the profile target is a floor as well as a scale.
    const budgetFloor = Math.round(barSeconds * settings.targetNps)
    return Math.max(1, Math.min(inBar.length, budgetFloor), Math.round(Math.min(budgetByTime, Math.max(1, budgetByOnsets))))
  }

  const units: { id: number; bars: number[] }[] = groups.members.map((bars, id) => ({ id, bars }))
  for (const bar of byBar.keys()) {
    if ((groups.groupOfBar[bar] ?? -1) < 0) units.push({ id: groups.members.length + bar, bars: [bar] })
  }

  const kept: Candidate[] = []
  for (const unit of units) {
    const present = unit.bars.filter((bar) => byBar.has(bar))
    if (present.length === 0) continue
    const budget = Math.round(median(present.map((bar) => barBudget(bar, byBar.get(bar)!))))
    if (budget <= 0) continue

    const slots = new Map<number, Candidate[]>()
    for (const bar of present) {
      for (const candidate of byBar.get(bar)!) {
        const slot = candidate.step - bar * stepsPerBar
        const list = slots.get(slot)
        if (list) list.push(candidate)
        else slots.set(slot, [candidate])
      }
    }

    const size = unit.bars.length
    const ranked = [...slots.entries()]
      .map(([slot, hits]) => {
        const beat = slot / settings.stepsPerBeat
        const onBeat = Math.abs(beat - Math.round(beat)) < 1e-6
        const onHalfBeat = Math.abs(beat * 2 - Math.round(beat * 2)) < 1e-6
        const beatBonus = onBeat ? settings.onBeatBonus : onHalfBeat ? settings.onBeatBonus * 0.45 : 0
        const strength = hits.reduce((acc, hit) => acc + hit.strength, 0) / hits.length
        const presence = hits.length / size
        const accent = Math.pow(clamp(strength, 0.001, 1), settings.accent) * (0.5 + 0.5 * presence)
        const chords = hits.filter((hit) => hit.simultaneousHits > 1).length / hits.length
        return {
          slot,
          hits,
          strength,
          presence,
          score: accent + beatBonus + chords * 0.16,
          keepAlways: onBeat && strength >= strongThreshold && presence >= 0.5,
        }
      })
      .filter((entry) => entry.presence >= MIN_SLOT_PRESENCE)
      .sort((a, b) => b.score - a.score || a.slot - b.slot)

    let used = 0
    for (const entry of ranked) {
      if (used >= budget && !entry.keepAlways) continue
      used++
      const held = entry.hits.flatMap((hit) => (hit.heldSeconds === undefined ? [] : [hit.heldSeconds]))
      const heldSeconds = held.length > 0 ? median(held) : undefined
      const pattern = `${unit.id}:${entry.slot}`
      const model = entry.hits.reduce((best, hit) => (hit.strength > best.strength ? hit : best))
      for (const bar of unit.bars) {
        const step = bar * stepsPerBar + entry.slot
        const own = entry.hits.find((hit) => hit.step === step)
        const mirrored = groups.mirrored[bar] ?? false
        if (own) {
          kept.push({ ...own, heldSeconds, pattern, mirrored })
          continue
        }
        if (entry.presence < FILL_SLOT_PRESENCE || size < FILL_MIN_BARS) continue
        const time = timing.stepToTime(step, settings.stepsPerBeat)
        if (time < 0 || time >= duration || isSilent(time)) continue
        kept.push({
          ...model,
          step,
          time,
          attack: time,
          strength: entry.strength,
          hits: 1,
          hitTimes: [time],
          hitBands: [model.band],
          simultaneousHits: 1,
          bands: [model.band],
          section: sectionAt(sections, time),
          heldSeconds,
          pattern,
          mirrored,
        })
      }
    }
  }

  return kept.sort((a, b) => a.step - b.step)
}

/** Sections snapshots come from different windows; merge identical kinds into one list. */
function dedupeSections(sections: Section[]): Section[] {
  const merged: Section[] = []
  for (const section of sections) {
    const existing = merged.find((s) => s.kind === section.kind)
    if (existing) {
      existing.start = Math.min(existing.start, section.start)
      existing.end = Math.max(existing.end, section.end)
      existing.energy = (existing.energy + section.energy) / 2
    } else {
      merged.push({ ...section })
    }
  }
  return merged
}

/* ----------------------------------------------------------------------------------------- */
/* Stage 4: lane assignment                                                                  */
/* ----------------------------------------------------------------------------------------- */

export interface LaneAssignmentResult {
  notes: ChartNote[]
  /** Notes relocated because the motif lane was physically blocked. */
  relocations: number
  dropped: number
  motifsUsed: string[]
}

export function chooseMotif(
  rng: Rng,
  candidate: Candidate,
  difficulty: Difficulty,
  previousMotifId: string,
): Motif {
  const sectionKind = candidate.section?.kind ?? 'groove'
  const weights = MOTIFS.map((motif) => {
    let weight = Math.pow(motif.density, difficulty === 'easy' ? 0.5 : difficulty === 'expert' ? 1.35 : 1)
    if (sectionKind === 'peak') weight *= motif.tags.includes('dense') ? 1.5 : 0.85
    if (sectionKind === 'sparse') weight *= motif.tags.includes('smooth') ? 1.7 : 0.7
    if (candidate.brightness > 0.55) weight *= motif.tags.includes('bright') || motif.tags.includes('jumpy') ? 1.45 : 0.9
    if (candidate.band <= 1) weight *= motif.tags.includes('kick') ? 1.5 : 1
    if (candidate.band >= 2) weight *= motif.tags.includes('techy') ? 1.35 : 0.95
    if (motif.id === previousMotifId) weight *= 0.4 // always vary phrase to phrase
    return Math.max(0.01, weight)
  })
  return rng.weighted(MOTIFS, weights)
}

/** Centre lane each spectral band gravitates to: bass left, hats right. */
const BAND_LANE_CENTER = [0.4, 1.3, 2.2, 3.1] as const

/** Minimum beats between chords. Easy/Normal never chord at all. */
const CHORD_GAP_BEATS: Record<Difficulty, number> = { easy: Infinity, normal: Infinity, hard: 4, expert: 4 }
/** Onset-strength quantile a pair must clear. */
const CHORD_STRENGTH_QUANTILE: Record<Difficulty, number> = { easy: 1, normal: 1, hard: 0.8, expert: 0.7 }
/** A quantile alone can be low in a quiet song; a jump still has to be an audible accent. */
const CHORD_MIN_STRENGTH: Record<Difficulty, number> = { easy: 1, normal: 1, hard: 0.5, expert: 0.45 }
/** A three-arrow hand is reserved for a real downbeat accent. */
const TRIPLE_GAP_BEATS: Record<Difficulty, number> = { easy: Infinity, normal: Infinity, hard: Infinity, expert: 6 }
const TRIPLE_STRENGTH_QUANTILE: Record<Difficulty, number> = { easy: 1, normal: 1, hard: 1, expert: 0.9 }
/** A four-arrow hand is the rarest accent in the chart. */
const QUAD_GAP_BEATS: Record<Difficulty, number> = { easy: Infinity, normal: Infinity, hard: Infinity, expert: 12 }
const QUAD_STRENGTH_QUANTILE: Record<Difficulty, number> = { easy: 1, normal: 1, hard: 1, expert: 0.97 }
/** Space around a chord so the player can recover and read the next note. */
const CHORD_RECOVERY_SECONDS: Record<Difficulty, number> = { easy: 0, normal: 0, hard: 0.36, expert: 0.28 }

export function assignLanes(
  candidates: Candidate[],
  timing: TimingMap,
  settings: GenerationSettings,
  difficulty: Difficulty,
  seed: number,
): LaneAssignmentResult {
  const rng = createRng(seed ^ 0x27d4eb2f)
  const notes: ChartNote[] = []
  const laneUse = [0, 0, 0, 0]
  /** Recent single arrows, to keep a run from hammering one column (the anchor rule). */
  const singles: { time: number; lane: Lane }[] = []
  const anchorLimit = ANCHOR_LIMIT[difficulty] ?? Infinity
  const runVisits = (lane: Lane, time: number): number => {
    const halfBeat = timing.secondsPerBeat(timing.timeToBeat(time)) * 0.5 + 1e-3
    let count = 0
    let previous = time
    const stop = Math.max(0, singles.length - anchorWindow(anchorLimit) + 1)
    for (let k = singles.length - 1; k >= stop && previous - singles[k].time <= halfBeat; k--) {
      if (singles[k].lane === lane) count++
      previous = singles[k].time
    }
    return count
  }
  const laneLastTime: number[] = [-Infinity, -Infinity, -Infinity, -Infinity]
  const handOf = (lane: Lane): 0 | 1 => (lane <= 1 ? 0 : 1)
  const strengthValues = candidates.map((c) => c.strength)
  const pairThreshold = Math.max(quantile(strengthValues, CHORD_STRENGTH_QUANTILE[difficulty]), CHORD_MIN_STRENGTH[difficulty])
  const tripleThreshold = quantile(strengthValues, TRIPLE_STRENGTH_QUANTILE[difficulty])
  const quadThreshold = quantile(strengthValues, QUAD_STRENGTH_QUANTILE[difficulty])
  const secondsPerBeat = Math.max(0.05, timing.secondsPerBeat(0))
  const minChordGap = CHORD_GAP_BEATS[difficulty] * secondsPerBeat
  const minTripleGap = TRIPLE_GAP_BEATS[difficulty] * secondsPerBeat
  const minQuadGap = QUAD_GAP_BEATS[difficulty] * secondsPerBeat
  const recovery = CHORD_RECOVERY_SECONDS[difficulty]
  const nextTimes = candidates.map((_, index) => candidates[index + 1]?.time ?? Number.POSITIVE_INFINITY)
  const stepsPerPhrase = Math.max(1, Math.round(settings.stepsPerBeat * 4))

  let lastLane: Lane | null = null
  let previousLane: Lane | null = null
  let lastNoteTime = -Infinity
  let lastChordTime = -Infinity
  let lastHandTime = -Infinity
  let lastChordLanes: Lane[] = []
  let relocations = 0
  let dropped = 0
  let currentPhrase = -1
  let currentMotif: Motif | null = null
  let motifCursor = 0
  const motifsUsed = new Set<string>()
  const remembered = new Map<string, Lane[]>()
  const flip = (lanes: Lane[], mirrored?: boolean): Lane[] => (mirrored ? lanes.map((lane) => (3 - lane) as Lane) : lanes)

  const commit = (candidate: Candidate, lanes: Lane[]): void => {
    if (candidate.pattern && !remembered.has(candidate.pattern)) remembered.set(candidate.pattern, flip(lanes, candidate.mirrored))
    for (const lane of lanes) {
      notes.push({
        id: `${difficulty}-${candidate.step}-${lane}`,
        lane,
        time: candidate.time,
        beat: candidate.step / settings.stepsPerBeat,
        step: candidate.step,
        kind: 'tap',
        strength: clamp(candidate.strength, 0.05, 1),
      })
      laneLastTime[lane] = candidate.time
      laneUse[lane]++
    }
    lastNoteTime = candidate.time
    previousLane = lastLane
    lastLane = lanes.length === 1 ? lanes[0] : null
    if (lanes.length === 1) singles.push({ time: candidate.time, lane: lanes[0] })
    else singles.length = 0
  }

  const chooseShape = (size: 2 | 3 | 4, candidate: Candidate, free: (lane: Lane) => boolean): Lane[] | null => {
    const shapes: Lane[][] =
      size === 4
        ? [[0, 1, 2, 3]]
        : size === 3
          ? [[0, 1, 3], [0, 2, 3], [0, 1, 2], [1, 2, 3]]
          : candidate.band <= 1
            ? [[0, 3], [1, 2], [0, 2], [1, 3]]
            : [[1, 2], [0, 3], [1, 3], [0, 2]]
    const freeShapes = shapes.filter((shape) => shape.every((lane) => free(lane as Lane)))
    if (freeShapes.length === 0) return null
    if (size === 2 && currentMotif) {
      const preferred = currentMotif.chords.find((shape) => shape.every((lane) => free(lane)))
      if (preferred) return [...preferred]
    }
    // Avoid repeating the exact same hand shape when another readable shape is free.
    const notRepeated = freeShapes.find(
      (shape) => !lastChordLanes.length || shape.some((lane) => !lastChordLanes.includes(lane as Lane)),
    )
    return notRepeated ?? freeShapes[0]
  }

  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const candidate = candidates[candidateIndex]
    if (candidate.time - lastNoteTime < settings.minGap - 1e-9) {
      dropped++
      continue
    }
    const beat = candidate.step / settings.stepsPerBeat
    const onQuarter = Math.abs(beat - Math.round(beat)) < 1e-6
    const onStrongBeat = Math.abs(beat / 2 - Math.round(beat / 2)) < 1e-6
    const onDownbeat = Math.abs(beat / 4 - Math.round(beat / 4)) < 1e-6
    const onEightBeat = Math.abs(beat / 8 - Math.round(beat / 8)) < 1e-6
    const fast = candidate.time - lastNoteTime < 0.32
    const free = (lane: Lane): boolean =>
      candidate.time - laneLastTime[lane] >= settings.minJackGap - 1e-9
    const phrase = Math.floor(candidate.step / stepsPerPhrase)
    if (phrase !== currentPhrase) {
      currentPhrase = phrase
      currentMotif = chooseMotif(rng, candidate, difficulty, currentMotif?.id ?? '')
      motifsUsed.add(currentMotif.id)
      motifCursor = 0
    }

    // The same music takes the same arrows, as long as they can physically be played here.
    const stored = candidate.pattern ? remembered.get(candidate.pattern) : undefined
    const repeat = stored && flip(stored, candidate.mirrored)
    if (repeat && repeat.every(free) && !(fast && repeat.length === 1 && repeat[0] === lastLane)) {
      commit(candidate, repeat)
      if (repeat.length > 1) {
        lastChordTime = candidate.time
        if (repeat.length >= 3) lastHandTime = candidate.time
        lastChordLanes = repeat
      }
      motifCursor++
      continue
    }

    // ---------------------------------------------------------------- chords
    // A jump is a musical accent, not the default reading of a dense passage. Require genuinely
    // simultaneous multi-band hits, a strong grid position, a strength above the chart's top
    // quantile, recovery time on both sides, and a long gap before the next chord. Expert earns a
    // triple only on a downbeat and a quad only on an eight-beat accent; Hard stays at pairs.
    const previousGap = candidate.time - lastNoteTime
    const nextGap = nextTimes[candidateIndex] - candidate.time
    const chordRoom = recovery <= 0 || (previousGap >= recovery && nextGap >= recovery)
    const pairWanted =
      settings.maxChord >= 2 &&
      candidate.simultaneousHits >= 2 &&
      candidate.bands.length >= 2 &&
      onQuarter &&
      onStrongBeat &&
      candidate.strength >= pairThreshold &&
      candidate.time - lastChordTime >= minChordGap - 1e-9 &&
      chordRoom
    let wantedSize: 2 | 3 | 4 | 0 = pairWanted ? 2 : 0
    if (
      pairWanted &&
      settings.maxChord >= 4 &&
      candidate.simultaneousHits >= 4 &&
      candidate.bands.length >= 3 &&
      candidate.strength >= quadThreshold &&
      onEightBeat &&
      candidate.time - lastHandTime >= minQuadGap - 1e-9
    ) {
      wantedSize = 4
    } else if (
      pairWanted &&
      settings.maxChord >= 3 &&
      candidate.simultaneousHits >= 3 &&
      candidate.bands.length >= 3 &&
      candidate.strength >= tripleThreshold &&
      onDownbeat &&
      candidate.time - lastHandTime >= minTripleGap - 1e-9
    ) {
      wantedSize = 3
    }

    if (wantedSize > 0) {
      for (let size = wantedSize; size >= 2; size--) {
        const shape = chooseShape(size as 2 | 3 | 4, candidate, free)
        if (!shape) continue
        commit(candidate, shape as Lane[])
        lastChordTime = candidate.time
        if (size >= 3) lastHandTime = candidate.time
        lastChordLanes = shape as Lane[]
        lastLane = null
        motifCursor++
        break
      }
      if (candidate.time - lastChordTime < 1e-9) continue
    }

    // ----------------------------------------------------------------- single
    // Score every lane on musical gravity (band), the phrase's motif, physical flow (distance from
    // the last note, hand alternation, jacks) and balance. Jitter is deliberately small: it varies
    // a pattern, it does not choose the lane from scratch.
    const preferredLane = currentMotif?.lanes[motifCursor % currentMotif.lanes.length] ?? null
    // When the next arrow repeats music already charted, its lanes are known: don't run into it
    // with a jack, or the repeat would have to give up its own lanes.
    const upcoming = candidates[candidateIndex + 1]
    const upcomingStored = upcoming?.pattern ? remembered.get(upcoming.pattern) : undefined
    const upcomingLanes =
      upcomingStored && upcoming.time - candidate.time < 0.32 ? flip(upcomingStored, upcoming.mirrored) : []
    let bestLane: Lane | null = null
    let bestScore = -Infinity
    for (const lane of LANES) {
      if (!free(lane)) continue
      const center = BAND_LANE_CENTER[clamp(candidate.band, 0, 3)] + (candidate.brightness - 0.5) * 0.8
      const gravity = -Math.abs(lane - center) * 1.05
      let flow = 0
      if (lastLane !== null) {
        const distance = Math.abs(lane - lastLane)
        if (fast) flow = distance === 2 ? 0.9 : distance === 1 ? 0.7 : distance === 3 ? 0.15 : -3
        else flow = distance === 1 ? 0.5 : distance === 2 ? 0.4 : distance === 3 ? 0.25 : -0.6
      }
      const sameHand = fast && lastLane !== null && handOf(lane) === handOf(lastLane) ? -1.5 : 0
      const repeat = lane === lastLane ? (fast ? -2.5 : -0.3) : 0
      const repeatTwo = lane === previousLane && lastLane !== null ? -0.4 : 0
      const balance = -(laneUse[lane] - Math.min(...laneUse)) * 0.22
      const anchor = onStrongBeat && (lane === 0 || lane === 3) ? 0.25 : 0
      const motifBonus = preferredLane === lane ? 0.42 : 0
      // Choosing a column the run already keeps returning to would only be moved again by the
      // anchor rule, differently on every repeat of the bar; avoid it here instead.
      // One short of the limit is penalised too, so a bar that will repeat in a stream leaves room
      // for its repeat.
      const visits = runVisits(lane, candidate.time) + 1
      const hammer = visits >= anchorLimit ? -2.2 : visits >= anchorLimit - 1 ? -1.2 : 0
      const intoRepeat = upcomingLanes.includes(lane) ? -2.5 : 0
      const score =
        gravity + flow + sameHand + repeat + repeatTwo + balance + anchor + motifBonus + hammer + intoRepeat +
        rng.range(-0.08, 0.08)
      if (score > bestScore) {
        bestScore = score
        bestLane = lane
      }
    }
    if (bestLane === null) {
      dropped++
      continue
    }
    if (lastLane !== null && Math.abs(bestLane - lastLane) > 1) relocations++
    commit(candidate, [bestLane])
    motifCursor++
  }

  return { notes: sortNotes(notes), relocations, dropped, motifsUsed: [...motifsUsed] }
}

/* ----------------------------------------------------------------------------------------- */
/* Stage 4b: holds on sustained passages                                                     */
/* ----------------------------------------------------------------------------------------- */

export interface HoldApplicationResult {
  notes: ChartNote[]
  holds: number
}

/** Share of notes that may become holds, per difficulty. Used only for pre-sustain analyses. */
const HOLD_CHANCE: Record<Difficulty, number> = { easy: 0.1, normal: 0.13, hard: 0.16, expert: 0.18 }
/**
 * Longest hold each difficulty will place, in seconds. The sound decides the length; these caps
 * only stop a pad that rings for bars from becoming a pole down the lane.
 */
const HOLD_MAX_SECONDS: Record<Difficulty, number> = { easy: 2, normal: 2.2, hard: 2.5, expert: 3 }
/** A release snaps onto another lane's arrow within this distance of where the sound ends. */
const RELEASE_ALIGN_SECONDS = 0.15
/** No other arrow may come this soon before a hold's release. */
const RELEASE_CLEAR_SECONDS = 0.3

/**
 * Shortest sustained sound that may become a hold, per difficulty, in seconds. The music decides:
 * a pad or held vocal rings well past this and becomes a short hold; a drum hit decays fast and
 * stays a tap.
 */
const HOLD_MIN_SUSTAIN: Record<Difficulty, number> = { easy: 0.5, normal: 0.45, hard: 0.4, expert: 0.35 }
/** Repeats of a held pattern may push the chart this far past its hold cap. */
const HOLD_REPEAT_ROOM = 1.6
/**
 * Hold shaping, tuned on 2026-11-07 against the StepMania and osu!mania charts of the same three
 * songs: holds went from 1.5 to 1.0 beats (the human median), holds where both humans tap fell
 * from 176 to 102, and a human hold starts under 43% of ours (was 35%).
 */
export const HOLD_SHAPE = {
  /** Share of the measured sustain a hold lasts: the envelope rings on after a player would let go. */
  lengthScale: 0.7,
  /** Most other-lane arrows per beat while a hold runs; a busier span stays a tap. */
  maxBusyPerBeat: 0.5,
}

/**
 * Turn notes into hold notes where the music sustains and the lane stays clear long enough.
 *
 * A hold is one judged note: its head is judged like a tap and the player must keep the key down
 * until the tail; releasing early drops the hold (combo break + accuracy penalty). When the
 * analysis measured sustain (`sustains`), the sound decides — only onsets whose envelope kept
 * ringing past the difficulty's minimum become holds, and the hold lasts as long as the sound
 * (snapped to the grid, capped per difficulty). Analyses saved before sustain measurement carry
 * no data here, and fall back to the old seeded coin-flip so old libraries keep their holds.
 *
 * A candidate is still required to
 *  - have room before the next note in its lane (tail plus a little clearance),
 *  - keep the tail inside the song,
 *  - be long enough to read as a hold rather than a tap, and
 *  - stay within the per-chart cap of holds.
 */
export function applyHolds(
  notes: ChartNote[],
  timing: TimingMap,
  duration: number,
  settings: GenerationSettings,
  difficulty: Difficulty,
  seed: number,
  sustains: ReadonlyMap<number, number> = new Map(),
  patterns: ReadonlyMap<number, string> = new Map(),
): HoldApplicationResult {
  if (notes.length === 0) return { notes, holds: 0 }
  const rng = createRng(seed ^ 0x51ed270b)
  const chance = HOLD_CHANCE[difficulty]
  const maxHoldSeconds = HOLD_MAX_SECONDS[difficulty]
  const minHoldSeconds = 0.24
  const minSustain = HOLD_MIN_SUSTAIN[difficulty]
  const tailClearance = 0.12
  const holdCap = Math.max(1, Math.floor(notes.length * 0.1))
  const songEnd = duration - 0.2
  const sustainAware = sustains.size > 0

  // A hold that starts on the same step as another arrow asks the player to hold and tap at once;
  // that combination is what made generated long/short pairs feel awkward. Keep holds for solo
  // starts only.
  const sameStep = new Map<number, number>()
  for (const note of notes) {
    const key = Math.round(note.time * 1000)
    sameStep.set(key, (sameStep.get(key) ?? 0) + 1)
  }

  // The next note in the same lane after each note, computed in one backward pass.
  const nextInLane = new Array<number>(notes.length).fill(Number.POSITIVE_INFINITY)
  const laneNext = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  for (let i = notes.length - 1; i >= 0; i--) {
    nextInLane[i] = laneNext[notes[i].lane]
    laneNext[notes[i].lane] = notes[i].time
  }

  let holds = 0
  const cleared = new Set<string>()
  const heldPatterns = new Set<string>()
  const out = notes.map((note, i) => {
    if (note.kind !== 'tap' || cleared.has(note.id)) return note
    // The cap is paced through the song so the long arrows don't all land in the opening. A pattern
    // that held before holds again, up to a hard limit.
    const pattern = patterns.get(Math.round(note.time * 1000))
    const allowed = pattern !== undefined && heldPatterns.has(pattern) ? holdCap * HOLD_REPEAT_ROOM : holdCap * ((i + 1) / notes.length)
    if (holds >= Math.max(1, allowed)) return note
    if ((sameStep.get(Math.round(note.time * 1000)) ?? 0) > 1) return note
    // Holds are anchors, not decoration. Keep their heads on a beat (Easy/Normal) or at least on
    // an eighth (Hard/Expert) so a short tap never starts halfway through a sung phrase.
    const onQuarter = Math.abs(note.beat - Math.round(note.beat)) < 1e-6
    const onEighth = Math.abs(note.beat * 2 - Math.round(note.beat * 2)) < 1e-6
    if (difficulty === 'easy' || difficulty === 'normal') {
      if (!onQuarter) return note
    } else if (!onEighth) {
      return note
    }
    const bound = Math.min(nextInLane[i] - tailClearance, note.time + maxHoldSeconds, songEnd)
    if (bound - note.time < minHoldSeconds) return note
    let wanted: number
    if (sustainAware) {
      const sustain = sustains.get(Math.round(note.time * 1000))
      if (sustain === undefined || sustain < minSustain) return note
      wanted = Math.min(sustain * HOLD_SHAPE.lengthScale, bound - note.time)
      if (wanted < minHoldSeconds) return note
    } else {
      const onBeat = Math.abs(note.beat - Math.round(note.beat)) < 1e-6
      if (rng.next() > (onBeat ? chance * 1.35 : chance)) return note
      wanted = bound - note.time
    }
    // Snap the tail to the subdivision grid so the export and the editor stay exact. `timeToStep`
    // rounds, so step down until the snapped time is really inside the wanted span.
    // Tails snap to the nearest 16th on every difficulty. Snapping down to Easy's whole beats
    // ended holds up to a beat before the sound did, so letting go "on time" felt early.
    const tailGrid = Math.max(4, settings.stepsPerBeat)
    let tailStep = Math.round(timing.timeToBeat(note.time + wanted) * tailGrid)
    while (tailStep > 0 && timing.stepToTime(tailStep, tailGrid) > bound + 1e-6) tailStep--
    let tailTime = timing.stepToTime(tailStep, tailGrid)
    // End on an arrow when one is close: the release lands together with another lane's note,
    // the way hand-made charts end their holds.
    let partner: ChartNote | null = null
    for (let j = i + 1; j < notes.length && notes[j].time <= tailTime + RELEASE_ALIGN_SECONDS; j++) {
      const other = notes[j]
      if (other.lane === note.lane || other.time < tailTime - RELEASE_ALIGN_SECONDS) continue
      if (!partner || Math.abs(other.time - tailTime) < Math.abs(partner.time - tailTime)) partner = other
    }
    if (partner && partner.time - note.time >= minHoldSeconds && partner.time <= bound + 1e-6) tailTime = partner.time
    const holdSeconds = tailTime - note.time
    if (holdSeconds < minHoldSeconds) return note
    let busy = 0
    for (let j = i + 1; j < notes.length && notes[j].time < tailTime - 1e-6; j++) {
      if (notes[j].lane !== note.lane && notes[j].time > note.time + 1e-6) busy++
    }
    const holdBeats = timing.timeToBeat(tailTime) - note.beat
    if (busy > HOLD_SHAPE.maxBusyPerBeat * Math.max(holdBeats, 0.25)) return note
    // Keep the run-up to the release clear: arrows in other lanes just before the tail make the
    // player split attention exactly when the hold needs it.
    for (let j = i + 1; j < notes.length && notes[j].time < tailTime - 1e-6; j++) {
      if (notes[j].lane !== note.lane && notes[j].time > tailTime - RELEASE_CLEAR_SECONDS && notes[j].kind === 'tap') {
        cleared.add(notes[j].id)
      }
    }
    holds++
    if (pattern !== undefined) heldPatterns.add(pattern)
    return { ...note, kind: 'hold' as const, duration: holdSeconds }
  })

  return { notes: out.filter((note) => note.kind === 'hold' || !cleared.has(note.id)), holds }
}

/* ----------------------------------------------------------------------------------------- */
/* Stage 5: statistics and rating                                                            */
/* ----------------------------------------------------------------------------------------- */

export function computeStats(notes: ChartNote[], duration: number): ChartStats {
  const noteCount = notes.length
  if (noteCount === 0) return { noteCount: 0, chordNotes: 0, peakNps: 0, avgNps: 0, rating: 1 }

  const byTime = new Map<number, number>()
  for (const note of notes) {
    const key = Math.round(note.time * 1000)
    byTime.set(key, (byTime.get(key) ?? 0) + 1)
  }
  const times = [...byTime.keys()].sort((a, b) => a - b)
  const chordNotes = [...byTime.values()].reduce((acc, count) => acc + (count > 1 ? count - 1 : 0), 0)

  let peakNps = 0
  let index = 0
  let running = 0
  for (let i = 0; i < times.length; i++) {
    running += byTime.get(times[i]) ?? 0
    while (times[i] - times[index] > 1000) {
      running -= byTime.get(times[index]) ?? 0
      index++
    }
    if (running > peakNps) peakNps = running
  }

  const span = Math.max(1, duration)
  const avgNps = noteCount / span
  const peakSteps = peakNps / 4
  const rating = clamp(Math.round((avgNps * 1.7 + peakSteps * 0.55) * 1.35), 1, 14)
  return { noteCount, chordNotes, peakNps, avgNps, rating }
}

/* ----------------------------------------------------------------------------------------- */
/* Song rating                                                                               */
/* ----------------------------------------------------------------------------------------- */

/** What the full-density chart says about the song itself. */
export interface SongRating {
  /** Plain-language class the song falls into at full (1:1) density. */
  difficulty: Difficulty
  /** Rating of the full chart on the 1–14 scale. */
  rating: number
  /** Note count of the full chart — what "1:1 with the music" means here in practice. */
  notes: number
}

// The recommendation is intentionally conservative. A full-density chart rated 11–12 is already
// a demanding "hard" chart by arcade standards; recommending Expert there would drop most players
// straight into the busiest chart the generator can make. Expert is reserved for the very top.
const SONG_CLASS_THRESHOLDS: { max: number; difficulty: Difficulty }[] = [
  { max: 3, difficulty: 'easy' },
  { max: 6, difficulty: 'normal' },
  { max: 12, difficulty: 'hard' },
  { max: Number.POSITIVE_INFINITY, difficulty: 'expert' },
]

/**
 * Rate a song from its generated charts.
 *
 * The full-density (expert) chart is the reference: it follows the music note-for-note, so its
 * rating says what the song itself demands. The class is the plain-language label for that
 * number, used to pre-select a chart and to tell the player what they are getting into. Each
 * difficulty is rated from its own notes, so switching difficulty visibly adds or removes arrows.
 */
export function rateSong(charts: Chart[]): SongRating | null {
  if (charts.length === 0) return null
  let full: Chart | null = null
  for (const difficulty of DIFFICULTIES) {
    const chart = charts.find((c) => c.difficulty === difficulty)
    if (chart) full = chart
  }
  if (!full) return null
  const rating = full.stats.rating
  const bucket = SONG_CLASS_THRESHOLDS.find((threshold) => rating <= threshold.max) ?? SONG_CLASS_THRESHOLDS[3]
  return { difficulty: bucket.difficulty, rating, notes: full.stats.noteCount }
}

/* ----------------------------------------------------------------------------------------- */
/* Pipeline                                                                                  */
/* ----------------------------------------------------------------------------------------- */

export interface GenerateChartInput {
  analysis: AnalysisResult
  timing: TimingMap
  duration: number
  songId: string
  difficulty: Difficulty
  title?: string
  options?: GenerateOptions
  settings?: Partial<GenerationSettings>
  /**
   * Playback edit (trimmed window + removed sections). Notes are always stored in original-audio
   * time; the plan only decides where charting is allowed, so what is heard and what is played
   * cannot disagree.
   */
  edit?: EditPlan | null
}

/**
 * Onsets the edit plan keeps: inside the window and not inside a removed section. Everything
 * downstream (density, lanes, holds) then sees the same grid it would for an untrimmed song.
 *
 * Trimmed windows need no extra ramp-in now: the playfield starts with a three-second countdown at
 * negative song time, so the first arrows approach from the bottom instead of appearing on the
 * receptors.
 */
function filterOnsetsForEdit(
  analysis: Pick<AnalysisResult, 'onsets' | 'sections' | 'silentRegions'>,
  edit: EditPlan | null | undefined,
): Pick<AnalysisResult, 'onsets' | 'sections' | 'silentRegions'> {
  if (!edit) return analysis
  const onsets = analysis.onsets.filter(
    (onset) =>
      Number.isFinite(onset.time) &&
      onset.time >= edit.windowStart - 1e-6 &&
      onset.time <= edit.windowEnd + 1e-6 &&
      !isCut(edit, onset.time),
  )
  return { onsets, sections: analysis.sections, silentRegions: analysis.silentRegions }
}

/** Shortest hold worth keeping when one has to be clipped at a cut. */
const MIN_CLIPPED_HOLD = 0.22

/** Largest grid position at or before `time`. */
function snapTailDown(timing: TimingMap, stepsPerBeat: number, time: number): number {
  let step = Math.round(timing.timeToStep(time, stepsPerBeat))
  while (step > 0 && timing.stepToTime(step, stepsPerBeat) > time + 1e-9) step--
  return timing.stepToTime(step, stepsPerBeat)
}

export interface ClippedNotes {
  notes: ChartNote[]
  /** Holds shortened because their tail reached into a removed section or past the window. */
  shortened: number
  /** Holds turned back into taps because too little would have remained. */
  downgraded: number
}

/**
 * Keep holds clear of the edit plan.
 *
 * The splice makes the clock jump over a removed interval, so a tail inside one could never be
 * held. Tails reaching a cut (or the end of the window) are shortened to the last grid step before
 * the boundary, or the note becomes a tap again when less than a minimum hold would remain.
 */
export function clipNotesToEdit(
  notes: ChartNote[],
  edit: EditPlan | null | undefined,
  duration: number,
  timing: TimingMap,
  stepsPerBeat: number,
): ClippedNotes {
  if (!edit) return { notes, shortened: 0, downgraded: 0 }
  const windowEnd = Math.min(edit.windowEnd, duration)
  const result: ChartNote[] = []
  let shortened = 0
  let downgraded = 0
  for (const note of notes) {
    if (note.time < edit.windowStart - 1e-6 || note.time > windowEnd + 1e-6 || isCut(edit, note.time)) continue
    if (note.kind !== 'hold' || !note.duration || note.duration <= 0) {
      result.push(note)
      continue
    }
    let tail = Math.min(note.time + note.duration, windowEnd)
    for (const cut of edit.cuts) {
      if (cut.start > note.time + 1e-6 && cut.start < tail) tail = cut.start
    }
    const snappedTail = snapTailDown(timing, stepsPerBeat, tail)
    const kept = snappedTail - note.time
    if (kept < MIN_CLIPPED_HOLD) {
      downgraded++
      result.push({ ...note, kind: 'tap', duration: undefined })
    } else if (kept < note.duration - 1e-6) {
      shortened++
      result.push({ ...note, duration: kept })
    } else {
      result.push(note)
    }
  }
  return { notes: result, shortened, downgraded }
}

const SLOW_TEMPO_BPM = 110

export function generateChart(input: GenerateChartInput): Chart {
  const { analysis, timing, duration, songId, difficulty } = input
  const overrides = { ...input.options?.overrides, ...input.settings }
  const settings = resolveSettings(difficulty, overrides)
  // Fast songs (170+ BPM) are often detected at half tempo. Their 16th notes then fall between the
  // 16th grid of the detected beat, so Hard/Expert use a twice-as-fine grid below 110 BPM.
  if (overrides.stepsPerBeat === undefined && settings.stepsPerBeat >= 4 && timing.primaryBpm < SLOW_TEMPO_BPM) {
    settings.stepsPerBeat *= 2
  }
  // Stable by song + difficulty + generator version. Deliberately excludes the detected BPM and
  // offset: a re-analysis that shifts the grid by a millisecond must not reshuffle every lane.
  const seed =
    input.options?.seed ??
    hashString(`${songId}|${difficulty}|${GENERATOR_VERSION}|${input.options?.salt ?? 0}`)

  const heard = filterOnsetsForEdit(analysis, input.edit)
  const selection = selectCandidates(heard, timing, duration, settings)
  const shaped = shapeDensity(selection.candidates, timing, duration, settings, difficulty, {
    groups: groupBars(heard.onsets, timing, duration, analysis.texture),
    sections: analysis.sections,
    isSilent: (time) => analysis.silentRegions.some((region) => time >= region.start - 0.05 && time <= region.end + 0.05),
  })
  const assignment = assignLanes(shaped, timing, settings, difficulty, seed)
  // Sustain per quantized step: a note whose sound keeps ringing in its own band becomes a hold.
  // Keyed by rounded milliseconds because lane assignment only ever reuses the candidate's time.
  const sustains = new Map<number, number>()
  const patterns = new Map<number, string>()
  for (const candidate of shaped) {
    const key = Math.round(candidate.time * 1000)
    if (candidate.pattern) patterns.set(key, candidate.pattern)
    if (candidate.heldSeconds === undefined) continue
    sustains.set(key, Math.max(sustains.get(key) ?? 0, candidate.heldSeconds))
  }
  const withHolds = applyHolds(assignment.notes, timing, duration, settings, difficulty, seed, sustains, patterns)
  const tidied = applyChartRules(withHolds.notes, timing, settings, difficulty)
  const clipped = clipNotesToEdit(tidied, input.edit, duration, timing, settings.stepsPerBeat)
  const notes = clipped.notes

  // Rated on the part that plays: a 60 s window of a 4-minute song is not four times easier.
  const stats = computeStats(notes, input.edit ? input.edit.duration : duration)
  const notes_: string[] = []
  if (selection.diagnostics.droppedOffGrid > 0) {
    notes_.push(`${selection.diagnostics.droppedOffGrid} onsets sat too far off the grid and were skipped.`)
  }
  if (assignment.relocations > 0) {
    notes_.push(`${assignment.relocations} notes moved lane to stay physically playable.`)
  }
  if (assignment.dropped > 0) {
    notes_.push(`${assignment.dropped} onsets were dropped because every lane was busy.`)
  }
  if (withHolds.holds > 0) {
    notes_.push(`${withHolds.holds} hold notes were placed where the lane stays clear.`)
  }
  if (clipped.downgraded > 0) {
    notes_.push(`${clipped.downgraded} holds became taps because the edit removes the audio after them.`)
  }
  if (clipped.shortened > 0) {
    notes_.push(`${clipped.shortened} holds were shortened to stop before a removed section.`)
  }
  if (notes.length === 0) {
    notes_.push('No arrows: the song had no clear hits to chart.')
  } else if (stats.chordNotes === 0 && settings.maxChord > 1) {
    notes_.push('No clear chord moments were found in this song, so this chart is single-note only.')
  }

  const generator: Chart['generator'] = {
    ...settings,
    version: GENERATOR_VERSION,
    source: 'analysis',
    seed,
    notes: notes_,
  }

  return {
    schema: 1,
    id: `chart_${songId}_${difficulty}`,
    songId,
    difficulty,
    title: input.title ?? '',
    timing: timing.toJSON(),
    stepsPerBeat: settings.stepsPerBeat,
    notes,
    stats,
    generator,
    edited: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export function generateAllDifficulties(
  input: Omit<GenerateChartInput, 'difficulty'> & { difficulties?: Difficulty[] },
): Chart[] {
  const list = input.difficulties ?? (['easy', 'normal', 'hard', 'expert'] as Difficulty[])
  return list.map((difficulty) => generateChart({ ...input, difficulty }))
}

/** Convenience: full pipeline straight from analysis + bpm/offset, used by the worker. */
export function generateFromAnalysis(
  analysis: AnalysisResult,
  bpm: number,
  offset: number,
  duration: number,
  songId: string,
  title: string,
  difficulties: Difficulty[],
  edit?: EditPlan | null,
): Chart[] {
  const timing = TimingMap.single(bpm, offset)
  return generateAllDifficulties({ analysis, timing, duration, songId, title, difficulties, edit })
}

/* ----------------------------------------------------------------------------------------- */
/* Playability validation                                                                    */
/* ----------------------------------------------------------------------------------------- */

export interface PlayabilityIssue {
  severity: 'error' | 'warning' | 'info'
  code:
    | 'unsorted'
    | 'duplicate'
    | 'negative-time'
    | 'past-end'
    | 'bad-hold'
    | 'inside-hold'
    | 'jack'
    | 'hand-repeat'
    | 'chord-size'
    | 'chord-after-chord'
    | 'peak-density'
    | 'dead-air'
  message: string
  time: number
  noteIds: string[]
}

export interface PlayabilityReport {
  ok: boolean
  issues: PlayabilityIssue[]
  errors: number
  warnings: number
}

/**
 * Validate that a chart is physically playable. Used by the test suite, the setup screen
 * ("playability" readout) and the editor.
 */
export function validatePlayability(
  chart: { notes: ChartNote[]; stepsPerBeat: number; generator?: Partial<GenerationSettings> },
  duration: number,
): PlayabilityReport {
  const issues: PlayabilityIssue[] = []
  const notes = chart.notes
  const maxChord = Math.max(1, chart.generator?.maxChord ?? 2)
  const minJackGap = chart.generator?.minJackGap ?? 0.14
  const minGap = chart.generator?.minGap ?? 0.09

  const bucket = (time: number): number => Math.round(time * 2000)
  const grouped = new Map<number, ChartNote[]>()
  for (const note of notes) {
    const key = bucket(note.time)
    const list = grouped.get(key)
    if (list) list.push(note)
    else grouped.set(key, [note])
  }
  const groupedSorted = [...grouped.entries()].sort((a, b) => a[0] - b[0])

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]
    if (note.time < -1e-6) {
      issues.push({ severity: 'error', code: 'negative-time', message: 'Note starts before the song.', time: note.time, noteIds: [note.id] })
    }
    if (note.time > duration + 0.001) {
      issues.push({ severity: 'warning', code: 'past-end', message: 'Note is placed after the end of the audio.', time: note.time, noteIds: [note.id] })
    }
    if (i > 0 && notes[i - 1].time > note.time + 1e-6) {
      issues.push({ severity: 'error', code: 'unsorted', message: 'Notes are not sorted by time.', time: note.time, noteIds: [notes[i - 1].id, note.id] })
    }
    if (note.kind === 'hold') {
      const length = note.duration ?? NaN
      if (!Number.isFinite(length) || length <= 0) {
        issues.push({ severity: 'error', code: 'bad-hold', message: 'A long arrow has no length.', time: note.time, noteIds: [note.id] })
      } else if (note.time + length > duration + 0.001) {
        issues.push({ severity: 'warning', code: 'past-end', message: 'A long arrow ends after the end of the audio.', time: note.time, noteIds: [note.id] })
      }
    }
  }

  // An arrow in a lane while that lane's long arrow is still held cannot be hit.
  const holdingUntil: { end: number; id: string }[] = [{ end: -1, id: '' }, { end: -1, id: '' }, { end: -1, id: '' }, { end: -1, id: '' }]
  for (const note of notes) {
    const held = holdingUntil[note.lane]
    if (held && note.time > -1e-6 && note.time < held.end - 1e-3) {
      issues.push({ severity: 'error', code: 'inside-hold', message: 'An arrow sits inside a long arrow in the same lane.', time: note.time, noteIds: [held.id, note.id] })
    }
    if (note.kind === 'hold' && Number.isFinite(note.duration) && (note.duration ?? 0) > 0 && held) {
      holdingUntil[note.lane] = { end: Math.max(held.end, note.time + (note.duration ?? 0)), id: note.id }
    }
  }

  for (const [key, list] of groupedSorted) {
    const lanes = new Set(list.map((n) => n.lane))
    if (lanes.size !== list.length) {
      issues.push({ severity: 'error', code: 'duplicate', message: 'Two notes share a lane at the same time.', time: key / 2000, noteIds: list.map((n) => n.id) })
    }
    if (list.length > maxChord) {
      issues.push({
        severity: 'error',
        code: 'chord-size',
        message: `${list.length}-note chord exceeds this chart's maximum of ${maxChord}.`,
        time: key / 2000,
        noteIds: list.map((n) => n.id),
      })
    }
  }

  const lastTimeByLane = [-Infinity, -Infinity, -Infinity, -Infinity]
  const lastTimeByHand: [number, number] = [-Infinity, -Infinity]
  let previousChord: { time: number; lanes: number[] } | null = null

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i]
    const group = grouped.get(bucket(note.time))!
    if (group.length > 1) {
      if (group[0] === note) {
        if (previousChord && note.time - previousChord.time < minGap * 2 - 1e-9) {
          issues.push({
            severity: 'warning',
            code: 'chord-after-chord',
            message: 'Two chords back to back with no recovery time.',
            time: note.time,
            noteIds: group.map((n) => n.id),
          })
        }
        previousChord = { time: note.time, lanes: group.map((n) => n.lane) }
        for (const member of group) {
          lastTimeByLane[member.lane] = member.time
          lastTimeByHand[member.lane <= 1 ? 0 : 1] = member.time
        }
      }
      continue
    }
    const jackDelta = note.time - lastTimeByLane[note.lane]
    if (jackDelta < minJackGap - 1e-9) {
      issues.push({
        severity: jackDelta < minJackGap * 0.6 ? 'error' : 'warning',
        code: 'jack',
        message: `Lane ${note.lane} repeats after only ${(jackDelta * 1000).toFixed(0)} ms.`,
        time: note.time,
        noteIds: [note.id],
      })
    }
    const hand = note.lane <= 1 ? 0 : 1
    const handDelta = note.time - lastTimeByHand[hand]
    if (handDelta < minGap * 0.6 - 1e-9) {
      issues.push({
        severity: 'warning',
        code: 'hand-repeat',
        message: `Same hand twice within ${(handDelta * 1000).toFixed(0)} ms.`,
        time: note.time,
        noteIds: [note.id],
      })
    }
    if (previousChord && previousChord.lanes.includes(note.lane) && note.time - previousChord.time < minGap * 2 - 1e-9) {
      issues.push({
        severity: 'warning',
        code: 'chord-after-chord',
        message: 'A note lands on a lane that just took part in a chord.',
        time: note.time,
        noteIds: [note.id],
      })
    }
    lastTimeByLane[note.lane] = note.time
    lastTimeByHand[hand] = note.time
  }

  // Peak density ceiling.
  const times = notes.map((n) => n.time)
  let index = 0
  let running = 0
  const byTime = new Map<number, number>()
  for (const note of notes) byTime.set(note.time, (byTime.get(note.time) ?? 0) + 1)
  for (let i = 0; i < times.length; i++) {
    running += 1
    while (times[i] - times[index] > 1) {
      running -= 1
      index++
    }
    if (running > 12) {
      issues.push({
        severity: 'error',
        code: 'peak-density',
        message: `${running} notes within one second — beyond what four lanes can represent fairly.`,
        time: times[i],
        noteIds: [notes[i].id],
      })
      break
    }
  }

  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] > 8) {
      issues.push({
        severity: 'info',
        code: 'dead-air',
        message: `${(times[i] - times[i - 1]).toFixed(1)} s with no notes.`,
        time: times[i - 1],
        noteIds: [],
      })
    }
  }

  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.filter((i) => i.severity === 'warning').length
  return { ok: errors === 0, issues, errors, warnings }
}

/* ----------------------------------------------------------------------------------------- */
/* Difficulty transformation                                                                 */
/* ----------------------------------------------------------------------------------------- */

const rank = (difficulty: Difficulty): number => (['easy', 'normal', 'hard', 'expert'] as Difficulty[]).indexOf(difficulty)

/**
 * Derive a chart for another difficulty from an existing chart (no re-analysis). This is the
 * "difficulty transformation" path used by the editor's derive action and by the tests that check
 * monotonic density across difficulty levels.
 */
export function transformDifficulty(chart: Chart, target: Difficulty, duration: number, rngSeed = 1): Chart {
  const settings = resolveSettings(target, {})
  const timing = new TimingMap(chart.timing)
  const rng = createRng(hashString(`${chart.id}|${target}`) ^ rngSeed)

  const grouped = new Map<number, ChartNote[]>()
  for (const note of chart.notes) {
    const key = Math.round(note.time * 1000)
    const list = grouped.get(key)
    if (list) list.push(note)
    else grouped.set(key, [note])
  }
  const groups = [...grouped.entries()].sort((a, b) => a[0] - b[0])

  const harder = rank(target) > rank(chart.difficulty)
  const sourceRatio = Math.max(0.15, DIFFICULTY_PROFILES[chart.difficulty].keepRatio)
  const keep = harder ? 1 : clamp(settings.keepRatio / sourceRatio, 0.25, 1)

  const keptGroups: { time: number; notes: ChartNote[] }[] = []
  for (const [key, list] of groups) {
    if (keep < 1 && rng.next() > keep) continue
    keptGroups.push({ time: key / 1000, notes: list })
  }

  const threshold = quantile(
    keptGroups.map((g) => Math.max(...g.notes.map((n) => n.strength))),
    0.85,
  )

  const notes: ChartNote[] = []
  for (const group of keptGroups) {
    const ordered = [...group.notes].sort((a, b) => b.strength - a.strength)
    const maxSize = harder ? settings.maxChord : Math.min(settings.maxChord, ordered.length)
    const selected = ordered.slice(0, Math.max(1, maxSize))
    const strongest = Math.max(...ordered.map((n) => n.strength))
    if (!harder && ordered.length > 1 && strongest < threshold) selected.length = 1
    for (const note of selected) {
      const step = timing.timeToStep(group.time, settings.stepsPerBeat)
      notes.push({
        ...note,
        id: `${target[0]}${step}-${note.lane}`,
        time: group.time,
        beat: step / settings.stepsPerBeat,
        step,
      })
    }
  }

  const sorted = sortNotes(notes)
  return {
    ...chart,
    id: `chart_${chart.songId}_${target}`,
    difficulty: target,
    stepsPerBeat: settings.stepsPerBeat,
    notes: sorted,
    stats: computeStats(sorted, duration),
    generator: {
      ...chart.generator,
      ...settings,
      seed: chart.generator.seed,
      notes: [`Derived from the ${chart.difficulty} chart of the same song.`],
    },
    edited: true,
    updatedAt: Date.now(),
  }
}

export { createId }
