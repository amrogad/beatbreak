/**
 * Song analysis orchestrator.
 *
 * Pure function of (mono samples, sampleRate) → AnalysisResult. It runs inside the analysis worker
 * but is plain code, so the whole pipeline is unit-testable in Node.
 *
 * Pipeline: STFT → spectral flux + RMS → adaptive onset peak picking → band classification →
 * silence + section structure → tempo, phase and grid coverage.
 */
import type { AnalysisResult, OnsetEvent, Section } from '../core/types'
import { downsample, mean, normalize, sampleAt, stdDev } from '../core/math'
import { computeEnergyEnvelope, computeOnsetEnvelopes, computeStft, nextPow2, pickPeaks, refineOnsetTime } from './dsp'
import { detectTempoStability, estimateBeatsPerBar, estimateTempo } from './tempo'

export const ANALYSIS_VERSION = 'pulsegrid-analysis-1.4'

/** Longest sustain the analyser reports; anything longer is treated as a 3 s ring. */
const SUSTAIN_MAX_SECONDS = 3
/** The sound is over once the energy envelope falls to this share of the attack's level. */
const SUSTAIN_DROP_RATIO = 0.5

/**
 * How long the sound behind one onset keeps ringing, in seconds. Walks the normalized RMS
 * envelope forward from the attack until it drops below half of the attack's level, or until a
 * clearly stronger new hit arrives (that is a new attack, not the same sound ringing). This is
 * what turns sustained music into hold notes and drum hits into taps. One linear scan per onset —
 * negligible next to the STFT.
 */
function estimateHeldSeconds(
  attackFrame: number,
  attackStrength: number,
  rms: Float32Array,
  frameRate: number,
  peaks: { position: number; strength: number }[],
  attackPeakIndex: number,
): number {
  const clampSeconds = (value: number): number => Math.max(0.05, Math.min(SUSTAIN_MAX_SECONDS, value))
  const sample = (frame: number): number => (frame >= 0 && frame < rms.length ? rms[frame] : 0)
  let reference = 0
  for (let frame = attackFrame - 2; frame <= attackFrame + 3; frame++) {
    reference = Math.max(reference, sample(frame))
  }
  if (reference <= 1e-5) return 0.05
  const threshold = reference * SUSTAIN_DROP_RATIO
  const maxFrames = Math.ceil(SUSTAIN_MAX_SECONDS * frameRate)
  // Start just past the attack itself so the transient cannot count as sustain.
  const firstFrame = attackFrame + Math.max(1, Math.round(0.03 * frameRate))
  let end = firstFrame
  let nextPeak = attackPeakIndex + 1
  for (let step = 0; step < maxFrames; step++) {
    const frame = firstFrame + step
    if (sample(frame) < threshold) break
    while (nextPeak < peaks.length && peaks[nextPeak].position <= frame) {
      if (peaks[nextPeak].strength >= attackStrength * 1.6) {
        return clampSeconds((peaks[nextPeak].position - attackFrame) / frameRate)
      }
      nextPeak++
    }
    end = frame
  }
  return clampSeconds((end + 1 - attackFrame) / frameRate)
}

export interface AnalyzeOptions {
  /** Analysis frame size; defaults to ~46 ms (2048 @ 44.1 kHz). */
  frameSize?: number
  /** Analysis frames per second; defaults to ~86. */
  frameRate?: number
  bands?: number
  onProgress?: (stage: string, fraction: number) => void
}

/** Band metadata for lane/pattern decisions: 0=sub, 1=low-mid, 2=high-mid, 3=high. */
export const BAND_LABELS = ['low', 'low-mid', 'high-mid', 'high'] as const

export function analyzeSamples(mono: Float32Array, sampleRate: number, options: AnalyzeOptions = {}): AnalysisResult {
  const progress = options.onProgress ?? (() => {})
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('The analyser received an invalid sample rate.')
  }
  // A detached (transferred) buffer also reports length 0 — fail early instead of running the
  // whole pipeline on nothing.
  if (mono.length === 0) {
    throw new Error('The analyser received no audio samples.')
  }
  const frameSize = options.frameSize ?? nextPow2(sampleRate * 0.046)
  const targetRate = options.frameRate ?? 86
  const hopSize = Math.max(64, Math.round(sampleRate / targetRate))
  const bands = options.bands ?? 4
  const duration = mono.length / sampleRate
  /**
   * Flux peaks appear slightly before the true attack: half a window plus one hop, because the
   * flux is largest while the transient is rising through the analysis window. `refineOnsetTime`
   * uses this delay as the centre of its search window.
   */
  const fluxDelaySeconds = frameSize / (2 * sampleRate) + hopSize / sampleRate

  progress('Computing spectrum', 0.05)
  const stft = computeStft(mono, sampleRate, { frameSize, hopSize, bands }, (f) =>
    progress('Computing spectrum', 0.05 + f * 0.35),
  )

  progress('Detecting onsets', 0.45)
  const envelopes = computeOnsetEnvelopes(mono, sampleRate, stft, { frameSize, hopSize, bands })
  const frameRate = envelopes.frameRate
  const peaks = pickPeaks(envelopes.flux, frameRate, { delta: 0.06, windowSeconds: 0.28, minGapSeconds: 0.055 })

  // Fine energy envelope used to snap every onset onto its real attack (removes the analysis
  // window's group delay, which would otherwise bias notes late by tens of milliseconds).
  const fine = computeEnergyEnvelope(mono, sampleRate, { blockMs: 1, smoothMs: 10 })

  const strengths = peaks.map((p) => p.strength)
  const strengthMean = mean(strengths)
  const strengthStd = stdDev(strengths, strengthMean)

  const onsets: OnsetEvent[] = []
  for (let peakIndex = 0; peakIndex < peaks.length; peakIndex++) {
    const peak = peaks[peakIndex]
    const bandValues = envelopes.bandFlux.map((b) => sampleAt(b, peak.position))
    let dominant = 0
    for (let b = 1; b < bandValues.length; b++) if (bandValues[b] > bandValues[dominant]) dominant = b
    const bandTotal = bandValues.reduce((a, b) => a + b, 0) || 1
    const brightness = (bandValues[2] + bandValues[3]) / bandTotal
    // Map the envelope peak onto an absolute-ish strength: 0.6 ≈ average hit, 1 ≈ well above the
    // noise floor. Used later to decide which onsets deserve notes and chords.
    const z = strengthStd > 1e-6 ? (peak.strength - strengthMean) / strengthStd : 0
    const normalized = Math.max(0.15, Math.min(1, 0.62 + z * 0.22))
    const approximate = peak.position / frameRate
    const time = refineOnsetTime(fine.envelope, fine.rate, approximate, fluxDelaySeconds)
    if (time < 0 || time > duration) continue
    onsets.push({
      time,
      strength: Math.max(0.08, Math.min(1, normalized * (0.55 + 0.45 * peak.strength))),
      band: dominant,
      brightness,
      heldSeconds: estimateHeldSeconds(
        Math.round(time * frameRate),
        peak.strength,
        envelopes.rms,
        frameRate,
        peaks,
        peakIndex,
      ),
    })
  }

  progress('Estimating tempo', 0.7)
  const tempoResult = estimateTempo(envelopes.flux, frameRate, onsets, {})
  const periodSeconds = 60 / tempoResult.bpm
  const { beatsPerBar } = estimateBeatsPerBar(onsets, periodSeconds, tempoResult.phase)

  progress('Building sections', 0.85)
  const silentRegions = detectSilentRegions(envelopes.rms, frameRate, duration)
  const sections = detectSections(envelopes.rms, frameRate, duration, silentRegions)

  const limitations = [...tempoResult.limitations]
  const stability = detectTempoStability(envelopes.flux, frameRate, {})
  if (!stability.stable) {
    limitations.push(
      `Tempo may change during the song (first half ≈ ${Math.round(stability.firstBpm)} BPM, second half ≈ ` +
        `${Math.round(stability.secondBpm)} BPM). A single constant tempo is assumed — correct the BPM below if ` +
        'the arrows drift out of sync.',
    )
  }
  const silentDuration = silentRegions.reduce((acc, r) => acc + (r.end - r.start), 0)
  if (silentDuration > Math.max(3, duration * 0.15)) {
    limitations.push(
      `About ${Math.round((silentDuration / duration) * 100)}% of the song is near-silent — no notes are placed there.`,
    )
  }
  if (onsets.length < 24) {
    limitations.push(
      'Very few onsets were detected, so the chart will be sparse. This material may be ambient, spoken or very quiet.',
    )
  }

  progress('Finalizing', 0.95)
  const beatTimes: number[] = []
  for (let t = tempoResult.phase; t < duration; t += periodSeconds) {
    if (t >= 0) beatTimes.push(t)
  }

  const envelopeBuckets = 900
  const result: AnalysisResult = {
    version: ANALYSIS_VERSION,
    bpm: tempoResult.bpm,
    bpmConfidence: tempoResult.confidence,
    offset: tempoResult.phase,
    phaseConfidence: tempoResult.phaseConfidence,
    gridResidualMs: tempoResult.gridResidualMs,
    candidates: tempoResult.candidates,
    beats: beatTimes.length,
    beatsPerBar,
    sections,
    silentRegions,
    limitations,
    envelope: downsample(normalize(envelopes.flux), envelopeBuckets),
    envelopeRate: envelopeBuckets / Math.max(0.001, duration),
    bandEnvelopes: envelopes.bandFlux.map((b) => downsample(b, envelopeBuckets)),
    onsets,
    beatTimes,
  }
  progress('Done', 1)
  return result
}

/**
 * Silence detection on the normalized RMS envelope: regions where energy stays under a fraction of
 * the track's typical level for at least ~0.35 s. These regions never receive notes, which is what
 * keeps intros, outros and breakdowns clean.
 */
export function detectSilentRegions(
  rms: Float32Array,
  frameRate: number,
  duration: number,
  options: { threshold?: number; minDuration?: number } = {},
): { start: number; end: number }[] {
  const minDuration = options.minDuration ?? 0.35
  const positive = Array.from(rms).filter((v) => v > 1e-4)
  if (positive.length === 0) return [{ start: 0, end: duration }]
  // Reference level = 40th percentile of non-silent energy, so a quiet-but-present part of a
  // dynamic song is not mistaken for silence.
  const sorted = positive.slice().sort((a, b) => a - b)
  const reference = sorted[Math.floor(sorted.length * 0.4)]
  const threshold = options.threshold ?? Math.max(0.02, reference * 0.18)

  const regions: { start: number; end: number }[] = []
  let runStart = -1
  for (let i = 0; i < rms.length; i++) {
    const silent = rms[i] <= threshold
    if (silent && runStart < 0) runStart = i
    if (!silent && runStart >= 0) {
      const start = runStart / frameRate
      const end = i / frameRate
      if (end - start >= minDuration) regions.push({ start, end })
      runStart = -1
    }
  }
  if (runStart >= 0) {
    const start = runStart / frameRate
    if (rms.length / frameRate - start >= minDuration) regions.push({ start, end: duration })
  }
  return regions
}

/**
 * Energy-structure segmentation: classify ~4 s windows by their RMS relative to the song average.
 * Used to shape chart density (sparser through quiet sections, denser at peaks).
 */
export function detectSections(
  rms: Float32Array,
  frameRate: number,
  duration: number,
  silentRegions: { start: number; end: number }[] = [],
  windowSeconds = 4,
): Section[] {
  const sections: Section[] = []
  if (duration <= 0 || rms.length === 0) return sections
  const windowFrames = Math.max(1, Math.round(windowSeconds * frameRate))
  const values = Array.from(rms)
  const overall = mean(values)
  const overallStd = stdDev(values, overall)
  const count = Math.max(1, Math.ceil(rms.length / windowFrames))

  const overlapWithSilence = (start: number, end: number): number => {
    let overlap = 0
    for (const region of silentRegions) {
      overlap += Math.max(0, Math.min(end, region.end) - Math.max(start, region.start))
    }
    return end > start ? overlap / (end - start) : 0
  }

  for (let w = 0; w < count; w++) {
    const startFrame = w * windowFrames
    const endFrame = Math.min(rms.length, startFrame + windowFrames)
    let sum = 0
    for (let i = startFrame; i < endFrame; i++) sum += rms[i]
    const energy = endFrame > startFrame ? sum / (endFrame - startFrame) : 0
    const start = startFrame / frameRate
    const end = Math.min(duration, endFrame / frameRate)

    let kind: Section['kind']
    if (overlapWithSilence(start, end) > 0.5) kind = 'silent'
    else if (energy < overall - 0.6 * overallStd || energy < overall * 0.45) kind = 'sparse'
    else if (energy > overall + 0.75 * overallStd) kind = 'peak'
    else if (end < duration * 0.66 && energy < overall + 0.2 * overallStd) kind = 'build'
    else kind = 'groove'

    const previous = sections[sections.length - 1]
    if (previous && previous.kind === kind && Math.abs(previous.end - start) < 1e-6) {
      previous.end = end
      previous.energy = (previous.energy + energy) / 2
    } else {
      sections.push({ start, end, energy, kind })
    }
  }
  return sections
}

/** Downmix AudioBuffer channel data to a single mono channel. */
export function downmixMono(channels: Float32Array[], length: number): Float32Array {
  if (channels.length === 1) return channels[0]
  const mono = new Float32Array(length)
  const scale = 1 / channels.length
  for (const channel of channels) {
    const n = Math.min(length, channel.length)
    for (let i = 0; i < n; i++) mono[i] += channel[i] * scale
  }
  return mono
}

