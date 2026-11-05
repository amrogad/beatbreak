/**
 * Tempo estimation and beat phase.
 *
 * Approach (documented, and deliberately honest about its limits):
 *
 *  1. Take the onset strength envelope from `computeOnsetEnvelopes`.
 *  2. Compute an *unbiased* global autocorrelation via FFT. (Windowed autocorrelation is biased
 *     towards short lags, which is a classic source of double-time octave errors — normalizing by
 *     the overlap length avoids it.)
 *  3. Score candidate lags with harmonic summation: a lag τ is supported by energy at 2τ, 3τ …
 *     which favours real beat periods over their integer sub-multiples.
 *  4. Apply a log-normal tempo prior centred near 120 BPM, then resolve octave ambiguity: between
 *     candidates related by a factor of ~2 or ~3 whose scores are close, pick the one nearest the
 *     canonical range. Tempo octaves are genuinely ambiguous in music (a backbeat at 64 BPM is
 *     indistinguishable from 128 BPM by autocorrelation alone), so this is a convention, not a
 *     measurement — the UI exposes BPM correction because of it.
 *  5. Find the beat phase by scoring candidate phases against the *detected onset times*
 *     (a sharp Gaussian alignment score), and report a grid-coverage confidence that measures how
 *     much of the onset energy actually falls on the resulting grid. A signal with no rhythm
 *     scores low here even if its autocorrelation happens to have a sharp peak.
 *
 * A real beat tracker (e.g. a trained downbeat model) can be dropped in later: everything
 * downstream consumes only `TempoEstimate`.
 */
import { normalize, sampleAt } from '../core/math'
import { fft, nextPow2 } from './dsp'
import type { OnsetEvent, TempoCandidate } from '../core/types'

export interface TempoEstimate {
  bpm: number
  /** 0..1 confidence: peak sharpness, octave support and how well onsets land on the grid. */
  confidence: number
  candidates: TempoCandidate[]
  /** Seconds of audio at beat 0 (first beat of the grid). */
  phase: number
  /** 0..1 fraction of onset energy that lands on the grid (8th-note level). */
  gridCoverage: number
  /** 0..1 legacy alias for grid alignment strength. */
  phaseConfidence: number
  /** RMS scatter of onsets around the fitted grid, in milliseconds. */
  gridResidualMs: number
  beatsPerBar: number
  limitations: string[]
}

export interface TempoOptions {
  minBpm?: number
  maxBpm?: number
  /** Tempo prior centre in BPM. */
  priorBpm?: number
  /** Prior width in octaves (larger = more permissive). */
  priorWidthOctaves?: number
  /** BPM the octave tie-break considers "canonical". */
  canonicalBpm?: number
}

export const DEFAULT_TEMPO_RANGE = { minBpm: 45, maxBpm: 260 } as const

/**
 * Unbiased autocorrelation of `signal` for integer lags 0..maxLag, via FFT.
 * `out[lag] = Σ_i x[i]x[i+lag] / (n - lag)` — the (n-lag) divisor removes the systematic
 * decay that makes long lags lose to short ones.
 */
export function autocorrelation(signal: Float32Array, maxLag: number): Float32Array {
  const n = signal.length
  const out = new Float32Array(maxLag + 1)
  if (n === 0) return out

  let mu = 0
  for (let i = 0; i < n; i++) mu += signal[i]
  mu /= n

  const fftSize = nextPow2(2 * n)
  const re = new Float32Array(fftSize)
  const im = new Float32Array(fftSize)
  for (let i = 0; i < n; i++) re[i] = signal[i] - mu
  fft(re, im)
  for (let k = 0; k < fftSize; k++) {
    const magSq = re[k] * re[k] + im[k] * im[k]
    re[k] = magSq
    im[k] = 0
  }
  fft(re, im)
  const scale = 1 / fftSize
  const effectiveMax = Math.min(maxLag, n - 1)
  for (let lag = 0; lag <= effectiveMax; lag++) {
    out[lag] = (re[lag] * scale) / Math.max(1, n - lag)
  }
  return out
}

/** Harmonic summation + tempo prior on an autocorrelation curve. */
export function scoreTempoCandidates(
  ac: Float32Array,
  frameRate: number,
  options: TempoOptions = {},
): { lags: Float32Array; scores: Float32Array } {
  const minBpm = options.minBpm ?? DEFAULT_TEMPO_RANGE.minBpm
  const maxBpm = options.maxBpm ?? DEFAULT_TEMPO_RANGE.maxBpm
  const priorBpm = options.priorBpm ?? 120
  const priorWidth = options.priorWidthOctaves ?? 0.9

  const minLag = Math.max(2, Math.round((60 / maxBpm) * frameRate))
  const maxLag = Math.min(ac.length - 1, Math.round((60 / minBpm) * frameRate))
  const base = Math.max(1e-12, Math.abs(ac[0]))

  const lags: number[] = []
  const scores: number[] = []
  for (let lag = minLag; lag <= maxLag; lag++) {
    let harmonic = 0
    let weightSum = 0
    for (let h = 1; h <= 4; h++) {
      const idx = lag * h
      if (idx > ac.length - 1) break
      const weight = 1 / h
      harmonic += (ac[idx] / base) * weight
      weightSum += weight
    }
    if (weightSum <= 0) continue
    harmonic /= weightSum
    const bpm = (60 * frameRate) / lag
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / priorBpm) / priorWidth, 2))
    lags.push(lag)
    scores.push(harmonic * prior)
  }
  return { lags: Float32Array.from(lags), scores: Float32Array.from(scores) }
}

export interface TempoPick {
  index: number
  bpm: number
  score: number
  /** Local maxima in the score curve, best first. */
  candidates: { index: number; bpm: number; score: number }[]
  /** True when the octave preference changed the raw winner. */
  octaveAdjusted: boolean
  /** Human-readable note about the adjustment, for the limitations list. */
  adjustmentNote?: string
}

/**
 * Select the winning tempo.
 *
 * Raw winner = strongest harmonic+prior score. Then two musically-motivated preferences:
 *
 *  - If the winner is faster than people comfortably tap (> `comfortMaxBpm`, default 185) and its
 *    half-time relative is at least half as strong, take the half-time reading. This is what stops
 *    a 100 BPM track from being charted as 200 BPM because its hi-hats are on eighth notes.
 *  - If the winner sits in the comfortable range and its double-time relative is also comfortable
 *    and at least 60% as strong, take the double-time reading. A backbeat groove (kick on 1 and 3,
 *    snare on 2 and 4) is periodic at *two* beats, so the beat level can genuinely lose to the
 *    half-time level; this preference restores the level a player would tap.
 *
 * Both are conventions, not measurements — which is exactly why the setup screen exposes BPM.
 */
export function pickTempo(
  lags: Float32Array,
  scores: Float32Array,
  frameRate: number,
  options: TempoOptions & { tolerance?: number; comfortMaxBpm?: number; comfortMinBpm?: number } = {},
): TempoPick {
  const canonical = options.canonicalBpm ?? 120
  const comfortMax = options.comfortMaxBpm ?? 185
  const comfortMin = options.comfortMinBpm ?? 60

  const maxima: { index: number; bpm: number; score: number }[] = []
  for (let i = 1; i < scores.length - 1; i++) {
    if (scores[i] >= scores[i - 1] && scores[i] >= scores[i + 1]) {
      maxima.push({ index: i, bpm: (60 * frameRate) / lags[i], score: scores[i] })
    }
  }
  if (maxima.length === 0) {
    let best = 0
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i
    const bpm = scores.length > 0 ? (60 * frameRate) / lags[best] : canonical
    return { index: best, bpm, score: scores[best] ?? 0, candidates: [], octaveAdjusted: false }
  }
  maxima.sort((a, b) => b.score - a.score)

  let winner = maxima[0]
  let octaveAdjusted = false
  let adjustmentNote: string | undefined

  const relative = (target: number): (typeof maxima)[number] | undefined =>
    maxima.find((m) => Math.abs(m.bpm / target - 1) < 0.04)

  const note = (from: number, to: number): string =>
    `Tempo octaves were ambiguous (${Math.round(from)} BPM vs ${Math.round(to)} BPM); ` +
    `${Math.round(to)} BPM was chosen as the tapping tempo.`

  // Rule 1: the winner is too fast to be the tapping tempo — step down an octave.
  if (winner.bpm > comfortMax) {
    const half = relative(winner.bpm / 2)
    if (half && half.score >= winner.score * 0.5 && half.bpm >= comfortMin * 0.5) {
      adjustmentNote = note(winner.bpm, half.bpm)
      winner = half
      octaveAdjusted = true
    }
  } else if (winner.bpm >= comfortMin) {
    // Rule 2: the winner is comfortable — prefer a comfortable double-time relative.
    const double = relative(winner.bpm * 2)
    if (double && double.bpm <= comfortMax && double.score >= winner.score * 0.6) {
      adjustmentNote = note(winner.bpm, double.bpm)
      winner = double
      octaveAdjusted = true
    }
  }

  // Rule 3: amongst octave relatives that are practically tied, prefer the canonical range.
  if (!octaveAdjusted) {
    for (const candidate of maxima.slice(1)) {
      if (candidate.score < winner.score * 0.85) continue
      const ratio = candidate.bpm / winner.bpm
      const related = Math.abs(ratio - 2) < 0.08 || Math.abs(ratio - 0.5) < 0.05
      if (!related) continue
      const candidateDistance = Math.abs(Math.log2(candidate.bpm / canonical))
      const winnerDistance = Math.abs(Math.log2(winner.bpm / canonical))
      if (candidateDistance < winnerDistance - 0.05 && candidate.bpm <= comfortMax && candidate.bpm >= comfortMin) {
        adjustmentNote = note(winner.bpm, candidate.bpm)
        winner = candidate
        octaveAdjusted = true
        break
      }
    }
  }

  // Parabolic refinement around the winner in lag space.
  const i = winner.index
  const prev = scores[Math.max(0, i - 1)]
  const next = scores[Math.min(scores.length - 1, i + 1)]
  const denom = prev - 2 * scores[i] + next
  const shift = Math.abs(denom) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (prev - next)) / denom)) : 0
  const refinedLag = lags[i] + shift

  // The parabolic refinement must never drag the answer onto an octave relative.
  let bpm = refinedLag > 0 ? (60 * frameRate) / refinedLag : winner.bpm
  const raw = winner.bpm
  if (Math.abs(bpm / raw - 1) > 0.06) bpm = raw

  return { index: i, bpm, score: winner.score, candidates: maxima, octaveAdjusted, adjustmentNote }
}

export interface TempoRefinement {
  bpm: number
  phase: number
  /** RMS distance between onsets and their grid positions (seconds). */
  residualSeconds: number
  /** Number of onsets used in the fit. */
  used: number
  /** Fraction of onsets that fit the grid within a quarter of a subdivision. */
  fitRatio: number
}

export interface PhaseResult {
  /** Seconds of audio at beat 0. */
  phase: number
  /** 0..1 grid alignment score. */
  score: number
  /** 0..1 fraction of onset strength landing on the grid. */
  coverage: number
}

/**
 * Estimate the beat phase by aligning a grid to the detected onset *times*.
 *
 * Score(φ) = Σ_onsets strength·exp(−½(dist_to_nearest_grid_line(onset, φ)/σ)²) using the eighth-
 * note grid, so both on-beat and off-beat material pulls the phase into place, and loud hits vote
 * louder. σ defaults to 35 ms.
 */
export function estimatePhaseFromOnsets(
  onsets: OnsetEvent[],
  periodSeconds: number,
  options: { steps?: number; sigma?: number; subdivision?: number } = {},
): PhaseResult {
  const steps = options.steps ?? 200
  const sigma = options.sigma ?? 0.035
  const subdivision = options.subdivision ?? 2
  if (onsets.length === 0 || !Number.isFinite(periodSeconds) || periodSeconds <= 0) {
    return { phase: 0, score: 0, coverage: 0 }
  }
  const gridStep = periodSeconds / subdivision
  const totalStrength = onsets.reduce((acc, o) => acc + o.strength, 0) || 1

  let bestIndex = 0
  let bestScore = -1
  const scores = new Float32Array(steps)
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * gridStep
    let score = 0
    for (const onset of onsets) {
      const relative = onset.time - phase
      const distanceToGrid = relative - Math.round(relative / gridStep) * gridStep
      score += onset.strength * Math.exp(-0.5 * Math.pow(distanceToGrid / sigma, 2))
    }
    scores[s] = score
    if (score > bestScore) {
      bestScore = score
      bestIndex = s
    }
  }

  // Parabolic refinement over the circular phase axis.
  const prev = scores[(bestIndex - 1 + steps) % steps]
  const next = scores[(bestIndex + 1) % steps]
  const denom = prev - 2 * scores[bestIndex] + next
  const shift = Math.abs(denom) > 1e-12 ? Math.max(-0.5, Math.min(0.5, (0.5 * (prev - next)) / denom)) : 0
  const refined = (((bestIndex + shift) / steps) * gridStep + gridStep) % gridStep

  return { phase: refined, score: bestScore / totalStrength, coverage: bestScore / totalStrength }
}

/**
 * Refine tempo and phase using the detected onset times.
 *
 * Autocorrelation can only resolve the period to one lag quantum (1 / envelope rate ≈ 12 ms),
 * which is up to ~1% at 150 BPM — enough for the grid to drift a full beat over a three-minute
 * song, which players feel immediately. Onset times, on the other hand, are known to a few
 * milliseconds, so the tempo can be recovered much more precisely from them.
 *
 * Method: a two-stage search over (period, phase) maximising grid alignment
 *
 *   alignment(P, φ) = Σ_onsets strength · exp(−½·(distance_to_nearest_grid_line / σ)²)
 *
 * with the grid at 16th resolution (period/4), σ ≈ 30 ms. Because that grid repeats every
 * period/4, the phase dimension only needs to be searched over one 16th note. A coarse pass
 * (±1.5% around the estimate) is followed by a fine pass, then a weighted mean-residual polish
 * for the phase and a parabolic polish for the period. This is a global fit: unlike a sliding
 * phase tracker it cannot get dragged away by a loud section, and it degrades gracefully on real
 * music (the residual it reports tells the UI how tightly the song actually locked to the grid).
 */
export function refineTempoFromOnsets(
  onsets: OnsetEvent[],
  bpm: number,
  phase: number,
  options: { coarseSteps?: number; fineSteps?: number; sigmaSeconds?: number; searchRange?: number } = {},
): TempoRefinement {
  if (onsets.length < 8 || !Number.isFinite(bpm) || bpm <= 0) {
    return { bpm, phase, residualSeconds: 0, used: 0, fitRatio: 0 }
  }
  const coarseSteps = options.coarseSteps ?? 25
  const fineSteps = options.fineSteps ?? 13
  const sigma = options.sigmaSeconds ?? 0.03
  const searchRange = options.searchRange ?? 0.015
  const basePeriod = 60 / bpm

  const alignment = (period: number, phaseCandidate: number, slice: OnsetEvent[]): number => {
    const gridStep = period / 4
    let score = 0
    for (const onset of slice) {
      const relative = onset.time - phaseCandidate
      const distance = relative - Math.round(relative / gridStep) * gridStep
      score += onset.strength * Math.exp(-0.5 * (distance / sigma) * (distance / sigma))
    }
    return score
  }

  // Work on a bounded slice for the coarse pass so long songs stay fast (evenly sampled).
  const maxSamples = 1500
  const coarseSlice =
    onsets.length > maxSamples
      ? onsets.filter((_, index) => index % Math.ceil(onsets.length / maxSamples) === 0)
      : onsets

  const phaseSteps = 96
  const search = (
    periodLow: number,
    periodHigh: number,
    periodSteps: number,
    phaseBase: number,
    phaseStepsCount: number,
    slice: OnsetEvent[],
  ): { period: number; phase: number; score: number } => {
    let best = { period: periodLow, phase: phaseBase, score: -1 }
    for (let i = 0; i < periodSteps; i++) {
      const period = periodLow + ((periodHigh - periodLow) * i) / Math.max(1, periodSteps - 1)
      const gridStep = period / 4
      for (let j = 0; j < phaseStepsCount; j++) {
        const candidatePhase = phaseBase + (gridStep * j) / phaseStepsCount
        const score = alignment(period, candidatePhase, slice)
        if (score > best.score) best = { period, phase: candidatePhase, score }
      }
    }
    return best
  }

  const coarse = search(
    basePeriod * (1 - searchRange),
    basePeriod * (1 + searchRange),
    coarseSteps,
    phase,
    Math.min(phaseSteps, 48),
    coarseSlice,
  )
  const fine = search(
    coarse.period * (1 - searchRange / coarseSteps),
    coarse.period * (1 + searchRange / coarseSteps),
    fineSteps,
    coarse.phase,
    64,
    onsets,
  )
  let period = fine.period
  let currentPhase = fine.phase

  // Polish: parabolic period refinement, then a weighted mean-residual phase correction.
  const gridStep = period / 4
  const step = gridStep / 32
  const left = alignment(period - step, currentPhase, onsets)
  const middle = alignment(period, currentPhase, onsets)
  const right = alignment(period + step, currentPhase, onsets)
  const denom = left - 2 * middle + right
  if (Math.abs(denom) > 1e-12 && middle > left && middle > right) {
    const shift = Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denom))
    const candidate = period + shift * step
    if (Number.isFinite(candidate) && Math.abs(candidate / period - 1) < 0.002) {
      period = candidate
    }
  }

  const polishStep = period / 4
  for (let iteration = 0; iteration < 2; iteration++) {
    let weightSum = 0
    let correction = 0
    for (const onset of onsets) {
      const k = Math.round((onset.time - currentPhase) / polishStep)
      const residual = onset.time - (currentPhase + k * polishStep)
      if (Math.abs(residual) > polishStep * 0.5) continue
      weightSum += onset.strength
      correction += onset.strength * residual
    }
    if (weightSum <= 1e-9) break
    currentPhase += correction / weightSum
  }

  // Fit report: how many onsets sit on the grid (16th resolution, ≤ 40% of a 16th away).
  const reportStep = period / 4
  let sumSquares = 0
  let counted = 0
  for (const onset of onsets) {
    const k = Math.round((onset.time - currentPhase) / reportStep)
    const residual = onset.time - (currentPhase + k * reportStep)
    if (Math.abs(residual) > reportStep * 0.4) continue
    sumSquares += residual * residual
    counted++
  }

  let normalizedPhase = currentPhase % period
  if (normalizedPhase < 0) normalizedPhase += period

  return {
    bpm: 60 / period,
    phase: normalizedPhase,
    residualSeconds: counted > 0 ? Math.sqrt(sumSquares / counted) : 0,
    used: counted,
    fitRatio: onsets.length > 0 ? counted / onsets.length : 0,
  }
}

/** Fraction of onset strength that falls on the grid at a given subdivision level. */
export function measureGridCoverage(
  onsets: OnsetEvent[],
  periodSeconds: number,
  phase: number,
  options: { toleranceSeconds?: number; subdivision?: number } = {},
): number {
  const tolerance = options.toleranceSeconds ?? 0.045
  const subdivision = options.subdivision ?? 2
  if (onsets.length === 0) return 0
  const gridStep = periodSeconds / subdivision
  let onGrid = 0
  let total = 0
  for (const onset of onsets) {
    total += onset.strength
    const relative = onset.time - phase
    const distanceToGrid = Math.abs(relative - Math.round(relative / gridStep) * gridStep)
    if (distanceToGrid <= tolerance) onGrid += onset.strength
  }
  return total > 0 ? onGrid / total : 0
}

/**
 * Decide which grid line marks beat 0.
 *
 * A 16th-note grid fit is invariant to shifting by one grid step — the *positions* are the same
 * set — so the fit alone cannot tell whether beats land on the kick or on an offbeat. Two steps:
 *
 *  1. Eighth-note level: of the two ways to pair up the 16th lines, the one carrying more onset
 *     strength is the eighth grid. Music puts far more on eighths than on odd 16ths, so this is
 *     reliable even when the loudest single sound is syncopated.
 *  2. Beat level: of the two eighth lines, the beat is the one the low and low-mid hits (kick,
 *     bass, snare body) favour. Hi-hats are left out because they often sit on the offbeat.
 *
 * Choosing among all four 16th lines by raw loudness let a pumping bass or a swelling pad pull
 * beat 0 onto the second 16th, which put every Easy and Normal arrow between the beats.
 */
export function chooseBeatMarker(onsets: OnsetEvent[], periodSeconds: number, phase: number): number {
  if (onsets.length === 0 || periodSeconds <= 0) return phase
  const sixteenth = periodSeconds / 4
  const score = (candidate: number, step: number, sigma: number, use: (o: OnsetEvent) => number): number => {
    let total = 0
    for (const onset of onsets) {
      const weight = use(onset)
      if (weight <= 0) continue
      const relative = onset.time - candidate
      const distance = relative - Math.round(relative / step) * step
      total += weight * Math.exp(-0.5 * (distance / sigma) * (distance / sigma))
    }
    return total
  }
  const eighthScores = [0, 1].map((k) => score(phase + k * sixteenth, periodSeconds / 2, 0.03, (o) => o.strength))
  const eighth = eighthScores[0] >= eighthScores[1] ? 0 : 1
  const lowWeight = (o: OnsetEvent): number => (o.band <= 1 ? o.strength * o.strength : 0)
  let beatScores = [eighth, eighth + 2].map((k) => score(phase + k * sixteenth, periodSeconds, 0.04, lowWeight))
  // No low-end hits to go by (a cappella, solo piano): fall back to every band.
  if (beatScores[0] + beatScores[1] < 1e-6) {
    beatScores = [eighth, eighth + 2].map((k) => score(phase + k * sixteenth, periodSeconds, 0.04, (o) => o.strength * o.strength))
  }
  const beat = beatScores[0] >= beatScores[1] ? eighth : eighth + 2
  return phase + beat * sixteenth
}

/** Detect a likely bar length by scoring 3 vs 4 beat groups of onset energy. */
export function estimateBeatsPerBar(
  onsets: OnsetEvent[],
  periodSeconds: number,
  phase: number,
): { beatsPerBar: number; confidence: number } {
  if (onsets.length === 0 || periodSeconds <= 0) return { beatsPerBar: 4, confidence: 0 }
  const accumulate = (group: number): number => {
    let acc = 0
    for (const onset of onsets) {
      const relative = onset.time - phase
      const gridStep = periodSeconds * group
      const distanceToGrid = Math.abs(relative - Math.round(relative / gridStep) * gridStep)
      acc += onset.strength * Math.exp(-0.5 * Math.pow(distanceToGrid / (periodSeconds * 0.12), 2))
    }
    return acc
  }
  const three = accumulate(3)
  const four = accumulate(4)
  const total = three + four
  if (total <= 1e-9) return { beatsPerBar: 4, confidence: 0 }
  const confidence = Math.abs(four - three) / total
  const beatsPerBar = confidence < 0.1 ? 4 : four > three ? 4 : 3
  return { beatsPerBar, confidence }
}

/**
 * Tempo stability: compare the winning tempo of the first and second half.
 * A large difference (beyond octave equivalence) means the song probably changes tempo; the
 * generator then keeps a single grid and reports the limitation instead of pretending.
 */
export function detectTempoStability(
  envelope: Float32Array,
  frameRate: number,
  options: TempoOptions = {},
): { stable: boolean; firstBpm: number; secondBpm: number } {
  const half = Math.floor(envelope.length / 2)
  const minSamples = Math.round(frameRate * 6)
  if (half < minSamples) return { stable: true, firstBpm: 0, secondBpm: 0 }

  const maxLag = Math.round((60 / (options.minBpm ?? DEFAULT_TEMPO_RANGE.minBpm)) * frameRate)
  const measure = (signal: Float32Array): number => {
    const ac = autocorrelation(signal, maxLag)
    const { lags, scores } = scoreTempoCandidates(ac, frameRate, options)
    const pick = pickTempo(lags, scores, frameRate, options)
    return pick.bpm
  }
  const firstBpm = measure(envelope.slice(0, half))
  const secondBpm = measure(envelope.slice(half))
  if (!firstBpm || !secondBpm) return { stable: true, firstBpm, secondBpm }
  const logDiff = Math.abs(Math.log2(secondBpm / firstBpm))
  const folded = Math.min(logDiff % 1, 1 - (logDiff % 1)) // octave-equivalent distance
  return { stable: folded < 0.07, firstBpm, secondBpm }
}

/** Full tempo estimation. */
export function estimateTempo(
  envelopeIn: Float32Array,
  frameRate: number,
  onsets: OnsetEvent[] = [],
  options: TempoOptions = {},
): TempoEstimate {
  const envelope = normalize(envelopeIn)
  const limitations: string[] = []
  const maxLag = Math.round((60 / (options.minBpm ?? DEFAULT_TEMPO_RANGE.minBpm)) * frameRate)
  const ac = autocorrelation(envelope, maxLag)
  const { lags, scores } = scoreTempoCandidates(ac, frameRate, options)

  if (scores.length === 0) {
    limitations.push('No rhythmic content found — a default 120 BPM grid is used.')
    return {
      bpm: 120,
      confidence: 0,
      candidates: [],
      phase: 0,
      gridCoverage: 0,
      phaseConfidence: 0,
      gridResidualMs: 0,
      beatsPerBar: 4,
      limitations,
    }
  }

  const pick = pickTempo(lags, scores, frameRate, options)
  if (pick.octaveAdjusted && pick.adjustmentNote) {
    limitations.push(pick.adjustmentNote)
  }

  const bpm = pick.bpm
  const periodSeconds = 60 / bpm

  const phaseResult = estimatePhaseFromOnsets(onsets, periodSeconds)
  // Which half-grid offset marks beat 0 (kick/snare side rather than the offbeat hats).
  const coarsePhase = chooseBeatMarker(onsets, periodSeconds, phaseResult.phase)
  // Least-squares refinement against real onset times: removes the lag-quantization BPM error
  // (≈0.2%, which drifts a full beat over three minutes) and the phase bias it causes.
  const refinement = refineTempoFromOnsets(onsets, bpm, coarsePhase)
  const refinedBpm = refinement.used >= 8 ? refinement.bpm : bpm
  const refinedPeriod = 60 / refinedBpm
  const beatPhase = chooseBeatMarker(onsets, refinedPeriod, refinement.used >= 8 ? refinement.phase : coarsePhase)

  const beatCoverage =
    onsets.length > 0 ? measureGridCoverage(onsets, refinedPeriod, beatPhase, { subdivision: 1 }) : 0
  const eighthCoverage =
    onsets.length > 0 ? measureGridCoverage(onsets, refinedPeriod, beatPhase, { subdivision: 2 }) : 0
  const coverage = 0.6 * beatCoverage + 0.4 * eighthCoverage
  const { beatsPerBar, confidence: barConfidence } = estimateBeatsPerBar(onsets, refinedPeriod, beatPhase)

  // Confidence: sharp autocorrelation peak, octave support, and — most importantly — how much of
  // the detected onset energy actually lands on the resulting grid.
  const bestIndex = pick.index
  const windowSize = Math.max(1, Math.round(scores.length * 0.04))
  let localSum = 0
  let localCount = 0
  for (let i = Math.max(0, bestIndex - windowSize); i <= Math.min(scores.length - 1, bestIndex + windowSize); i++) {
    localSum += scores[i]
    localCount++
  }
  const localMean = localCount > 0 ? localSum / localCount : 0
  const sharpness = pick.score > 1e-9 ? Math.max(0, 1 - localMean / pick.score) : 0

  const supportScore = (target: number): number => {
    let best = 0
    for (let i = 0; i < scores.length; i++) {
      const candidateBpm = (60 * frameRate) / lags[i]
      if (Math.abs(candidateBpm - target) / target < 0.03) best = Math.max(best, scores[i])
    }
    return best
  }
  const octaveSupport =
    pick.score / Math.max(1e-9, Math.max(supportScore(refinedBpm * 2), supportScore(refinedBpm / 2)) + pick.score)

  const coverageTerm = Math.max(0, Math.min(1, (coverage - 0.25) / 0.4))
  // Residual term: how tightly the onsets actually sit on the fitted grid. Real rhythmic material
  // lands within ~10 ms; loosely played or non-rhythmic material scatters.
  const residualTerm = Math.max(0, Math.min(1, (0.035 - refinement.residualSeconds) / 0.025))
  const confidence = Math.max(
    0,
    Math.min(
      1,
      0.2 * Math.max(0, sharpness) + 0.1 * octaveSupport + 0.35 * coverageTerm + 0.35 * residualTerm,
    ),
  )

  if (coverage < 0.35 && onsets.length > 8) {
    limitations.push(
      `Only ${Math.round(coverage * 100)}% of the detected hits line up with the beat grid — this track may be ` +
        'rubato, heavily syncopated, or not very rhythmic. Charts from material like this need manual editing.',
    )
  } else if (refinement.residualSeconds > 0.022 && onsets.length > 40 && coverage < 0.62) {
    limitations.push(
      `Detected hits scatter by about ±${Math.round(refinement.residualSeconds * 1000)} ms around the beat grid — the ` +
        'track may be played loosely, change tempo, or not be strongly rhythmic. Check the BPM and offset, and edit ' +
        'the chart if the arrows feel off.',
    )
  } else if (confidence < 0.35) {
    limitations.push('Tempo is ambiguous — check the BPM and timing offset by ear.')
  } else if (confidence < 0.55) {
    limitations.push('Tempo confidence is moderate — double/half-time interpretations are possible; adjust if the arrows drift.')
  }
  if (barConfidence < 0.12) {
    limitations.push('Bar length could not be determined confidently; patterns are grouped in 4/4.')
  }

  const candidates: TempoCandidate[] = pick.candidates
    .slice()
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((c) => ({ bpm: c.bpm, score: c.score }))

  return {
    bpm: refinedBpm,
    confidence,
    candidates,
    phase: beatPhase,
    gridCoverage: coverage,
    phaseConfidence: beatCoverage,
    gridResidualMs: refinement.residualSeconds * 1000,
    beatsPerBar,
    limitations,
  }
}

/** Sample an envelope at a time in seconds (helper for callers working in song time). */
export function envelopeAt(envelope: Float32Array, frameRate: number, timeSeconds: number): number {
  return sampleAt(envelope, timeSeconds * frameRate)
}
