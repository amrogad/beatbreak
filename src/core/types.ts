/**
 * Core domain types for Beatbreak.
 *
 * Everything the game persists or hands between workers is defined here so that the
 * analysis worker, the chart generator, the engine and the UI all agree on one shape.
 */

/** Four lanes, index order is fixed and used everywhere (arrays, keys, rendering). */
export type Lane = 0 | 1 | 2 | 3

export const LANES: readonly Lane[] = [0, 1, 2, 3] as const
export const LANE_COUNT = 4

/** Key/visual identity per lane: left, down, up, right. */
export const LANE_INFO: readonly {
  lane: Lane
  id: string
  label: string
  color: string
  glow: string
  arrow: string
}[] = [
  // Okabe–Ito colours: sky blue, orange, bluish green and white. Direction is also encoded by the
  // arrow shape, so the four lanes stay readable with any form of colour vision.
  { lane: 0, id: 'left', label: 'Left', color: '#ff4f9a', glow: '#ff4f9a', arrow: '←' },
  { lane: 1, id: 'down', label: 'Down', color: '#3d9bff', glow: '#3d9bff', arrow: '↓' },
  { lane: 2, id: 'up', label: 'Up', color: '#3fe08a', glow: '#3fe08a', arrow: '↑' },
  { lane: 3, id: 'right', label: 'Right', color: '#ffc93d', glow: '#ffc93d', arrow: '→' },
] as const

export type Difficulty = 'easy' | 'normal' | 'hard' | 'expert'

export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard', 'expert'] as const

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: 'Easy',
  normal: 'Normal',
  hard: 'Hard',
  expert: 'Expert',
}

/** Colour per difficulty, used by chips, rating badges and the editor. */
export const DIFFICULTY_COLOR: Record<Difficulty, string> = {
  easy: '#3fe08a',
  normal: '#3d9bff',
  hard: '#ff7a3d',
  expert: '#ff4f9a',
}

export type NoteKind = 'tap' | 'hold'

/**
 * A single playable note.
 *
 * `time` is authoritative for gameplay and synchronization; `step` is the integer position on
 * the chart's subdivision grid (needed for exact `.sm` export and for the editor), and `beat`
 * is the fractional beat position.
 */
export interface ChartNote {
  id: string
  lane: Lane
  /** Seconds from the start of the audio file. */
  time: number
  /** Fractional beat position (0 = first beat). */
  beat: number
  /** Integer index on the subdivision grid; grid resolution is `stepsPerBeat` steps per beat. */
  step: number
  kind: NoteKind
  /** Onset strength 0..1 from the analysis, or 1 for hand-placed notes. */
  strength: number
  /** Seconds, hold notes only. */
  duration?: number
}

export interface BpmSegment {
  /** Beat at which this tempo takes effect. */
  beat: number
  bpm: number
}

/**
 * Timing map: tempo segments plus the audio offset (seconds of audio at beat 0).
 * A single segment is the normal case; the structure already supports tempo changes so a
 * better beat tracker (or the editor) can add regions without touching the engine.
 */
export interface Timing {
  offset: number
  bpms: BpmSegment[]
}

export interface ChartStats {
  noteCount: number
  chordNotes: number
  peakNps: number
  avgNps: number
  rating: number
}

export interface GeneratorSettings {
  /** Steps per beat used when snapping onsets to the grid (4 = 16th notes). */
  stepsPerBeat: number
  /** Target notes per second used as the density ceiling. */
  targetNps: number
  /** Maximum simultaneous notes allowed in this difficulty. */
  maxChord: number
  /** Minimum gap (seconds) between two notes in the same lane. */
  minJackGap: number
  /** Fraction of the strongest onsets kept (0..1). */
  keepRatio: number
  /** Scales onset strength before selection; higher = more emphasis on loud hits. */
  accent: number
  seed: number
}

export interface GeneratorInfo extends GeneratorSettings {
  version: string
  /** Human readable summary of how the chart was derived (shown in the UI). */
  source: 'analysis' | 'manual' | 'imported'
  notes: string[]
}

export interface Chart {
  schema: 1
  id: string
  songId: string
  difficulty: Difficulty
  title: string
  /** Timing map in absolute song time. */
  timing: Timing
  stepsPerBeat: number
  notes: ChartNote[]
  stats: ChartStats
  generator: GeneratorInfo
  /** True when a human edited the chart after generation. */
  edited: boolean
  createdAt: number
  updatedAt: number
}

/** Song record: metadata only. Audio bytes are never stored unless the user opts in. */
export interface SongMeta {
  id: string
  title: string
  artist: string
  fileName: string
  fileSize: number
  lastModified: number
  duration: number
  sampleRate: number
  channels: number
  /** Display waveform, 0..255 peak buckets. */
  peaks: Uint8Array
  /** Display onset envelope, 0..1 per bucket. */
  envelope: Float32Array
  /**
   * The difficulty the player last chose for this song. The setup screen only auto-selects the
   * recommended difficulty until this exists, then it respects the player's choice.
   */
  preferredDifficulty?: Difficulty
  /** Increments when the player asks for a new arrow variation. */
  chartVariant?: number
  /**
   * Playable region (seconds of the original audio). Notes are only generated inside it and
   * gameplay starts at `trimStart` and stops at `trimEnd`. Absent = the whole file.
   */
  trimStart?: number
  trimEnd?: number
  /**
   * Removed sections inside the window (seconds of the original audio). Playback splices them out
   * at bar boundaries and holds/charts are generated to avoid them; the clock jumps the cut.
   */
  trimCuts?: { start: number; end: number }[]
  analysis: AnalysisSummary
  createdAt: number
  lastPlayedAt: number
  /** True when the user explicitly asked to keep the decoded audio in this browser. */
  audioCached: boolean
}

export interface TempoCandidate {
  bpm: number
  score: number
}

export interface AnalysisSummary {
  version: string
  bpm: number
  /** 0..1 — how sharply the tempo estimator preferred this value. */
  bpmConfidence: number
  /** Seconds of audio at beat 0. */
  offset: number
  /** 0..1 — how well the onset grid lines up with the detected beat phase. */
  phaseConfidence: number
  /** RMS scatter of detected onsets around the fitted grid, in milliseconds (grid fit quality). */
  gridResidualMs: number
  candidates: TempoCandidate[]
  beats: number
  beatsPerBar: number
  /** Sections detected from energy structure, used for density shaping. */
  sections: Section[]
  /** Regions with essentially no musical content (silence / spoken intro). */
  silentRegions: { start: number; end: number }[]
  /** Honest caveats produced while analysing, surfaced in the UI. */
  limitations: string[]
}

export interface Section {
  start: number
  end: number
  /** Mean normalized energy 0..1. */
  energy: number
  kind: 'silent' | 'sparse' | 'groove' | 'build' | 'peak'
}

export interface OnsetEvent {
  time: number
  strength: number
  /** Dominant spectral band: 0 = sub/low (kick), 1 = low-mid, 2 = high-mid (snare/clap), 3 = high (hats). */
  band: number
  /** Extra strength in the high bands — used to pick brighter patterns on hats. */
  brightness: number
  /**
   * How long the sound behind this onset keeps ringing, in seconds (about 0.05–3, estimated from
   * the energy envelope). This is what decides holds: a pad or held vocal rings for a second and
   * becomes a long arrow, a drum hit decays fast and stays a tap. Optional so analyses saved
   * before this field existed still load — the generator falls back to its old hold heuristic
   * for those.
   */
  heldSeconds?: number
}

export interface SongTexture {
  /** Frames per second. */
  rate: number
  bands: number
  /** Loudness per frame and band, 0..255 on a log scale, frame-major. */
  data: Uint8Array
}

export interface AnalysisResult extends AnalysisSummary {
  /** Onset strength envelope for UI/preview (normalized 0..1). */
  envelope: Float32Array
  /** Frames per second of `envelope`. */
  envelopeRate: number
  /** Per-band onset strength envelopes (normalized), for future models. */
  bandEnvelopes: Float32Array[]
  onsets: OnsetEvent[]
  /** Small spectrogram of the song, for telling which bars are the same music. */
  texture?: SongTexture
  /** Detected beat times in seconds (musical grid, may extend past audio end). */
  beatTimes: number[]
}

export type Judgment = 'marvelous' | 'perfect' | 'great' | 'good' | 'miss'

export const JUDGMENTS: readonly Judgment[] = ['marvelous', 'perfect', 'great', 'good', 'miss'] as const

export interface JudgmentWindows {
  /** Absolute milliseconds; a tap within ±marvelous is a Marvelous, etc. */
  marvelous: number
  perfect: number
  great: number
  good: number
  /**
   * Beyond `good` a tap is ignored (not consumed) and a note that has passed `missAfter` becomes
   * a Miss. Presets set this equal to `good`, matching "Miss beyond the last hit window".
   */
  missAfter: number
}

export interface JudgmentTally {
  marvelous: number
  perfect: number
  great: number
  good: number
  miss: number
}

/**
 * When a run fails. `never` plays the chart to the end no matter what; the numbered rules fail
 * after that many misses; `accuracy` is the arcade rule (fails when accuracy collapses).
 */
export type FailRule = 'never' | 'accuracy' | 'miss1' | 'miss3' | 'miss5' | 'miss10'

export const FAIL_RULES: readonly FailRule[] = ['never', 'accuracy', 'miss1', 'miss3', 'miss5', 'miss10'] as const

export const FAIL_RULE_LABEL: Record<FailRule, string> = {
  never: 'No fail - play to the end',
  accuracy: 'Arcade — fail when accuracy collapses',
  miss1: 'Fail on 1 miss',
  miss3: 'Fail on 3 misses',
  miss5: 'Fail on 5 misses',
  miss10: 'Fail on 10 misses',
}

export interface ScoreState {
  score: number
  combo: number
  bestCombo: number
  accuracy: number
  judged: number
  tally: JudgmentTally
  totalNotes: number
  /** Holds released too early: each breaks the combo and counts against accuracy and fail rules. */
  droppedHolds: number
  /** Points multiplier for the chart's difficulty (Easy 1x up to Expert 3x). */
  scoreScale?: number
}

export interface HitEvent {
  judgment: Judgment
  lane: Lane
  /** Signed timing error in milliseconds (negative = early). */
  deltaMs: number
  noteId: string
  /** Absolute song time of the judgment. */
  time: number
  comboAfter: number
  scoreAfter: number
  /** Consecutive Marvelous judgements up to and including this one. */
  marvelousStreak: number
  /**
   * True when this event is a hold scored as LetGo: the key was released for longer than
   * StepMania's hold window. The judgement is a miss for scoring; the flag only drives feedback
   * (the playfield prints LET GO instead of a bare MISS).
   */
  holdDrop?: boolean
}

export interface RunResults {
  songId: string
  chartId: string
  difficulty: Difficulty
  score: number
  accuracy: number
  bestCombo: number
  tally: JudgmentTally
  totalNotes: number
  grade: string
  failed: boolean
  createdAt: number
  /** Mean signed timing error of hit notes in ms (negative = early). Absent on old records. */
  meanTimingMs?: number
  /** Holds released too early during the run. Absent on old records. */
  droppedHolds?: number
  /** True when this run was played in auto-play (verify) mode, so it is not a real score. */
  autoPlay?: boolean
}
