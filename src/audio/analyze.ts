/**
 * Song analysis orchestrator.
 *
 * Pure function of (mono samples, sampleRate) → AnalysisResult. It runs inside the analysis worker
 * but is plain code, so the whole pipeline is unit-testable in Node.
 *
 * Pipeline: STFT → spectral flux + RMS → adaptive onset peak picking → band classification →
 * silence + section structure → tempo, phase and grid coverage.
 */
import type { AnalysisResult, OnsetEvent, Section, SongTexture } from '../core/types'
import { downsample, mean, normalize, sampleAt, stdDev } from '../core/math'
import {
  computeEnergyEnvelope,
  computeOnsetEnvelopes,
  forEachSpectrum,
  nextPow2,
  pickPeaks,
  refineOnsetTime,
  spectralFlux,
  stftLayout,
  type StftLayout,
} from './dsp'
import { detectTempoStability, estimateBeatsPerBar, estimateTempo, polishTempo, settleBeatLine } from './tempo'
import { tempoFromRepeats } from '../chart/structure'

export const ANALYSIS_VERSION = 'pulsegrid-analysis-2.5'

/**
 * Players place a beat a little before the energy peak our detector locks onto. Compared with
 * the human charts that ship with StepMania, the fitted grid sat 10-30 ms late on every song
 * tested, so the grid is moved this much earlier.
 */
const PERCEIVED_LEAD_SECONDS = 0.01

/** Longest sustain the analyser reports; anything longer is treated as a 3 s ring. */
const SUSTAIN_MAX_SECONDS = 3
/** The sound is over once its band's energy falls to this share of its settled level. */
const SUSTAIN_DROP_RATIO = 0.2
/** A sound whose energy settles below this share of its attack peak is a hit, not a held note. */
const SUSTAIN_BODY_RATIO = 0.12

/**
 * How long the sound behind one onset keeps ringing, in seconds, measured in the onset's own
 * frequency band. Walks that band's energy forward from the attack until it drops well below
 * its settled level (20%), or until the same band is struck again (a new note, not the same one
 * ringing), or a much stronger hit lands anywhere. Measuring per band is what separates a held
 * vocal or pad from a busy mix: the whole-mix loudness of a dense track never drops, so it made
 * almost every note look sustained.
 */
function estimateHeldSeconds(
  attackFrame: number,
  attackStrength: number,
  bandEnergy: Float32Array,
  bandFlux: Float32Array,
  frameRate: number,
  peaks: { position: number; strength: number }[],
  attackPeakIndex: number,
): number {
  const clampSeconds = (value: number): number => Math.max(0.05, Math.min(SUSTAIN_MAX_SECONDS, value))
  const sample = (frame: number): number => (frame >= 0 && frame < bandEnergy.length ? bandEnergy[frame] : 0)
  let peakEnergy = 0
  for (let frame = attackFrame - 2; frame <= attackFrame + 3; frame++) {
    peakEnergy = Math.max(peakEnergy, sample(frame))
  }
  if (peakEnergy <= 1e-9) return 0.05
  // Judge the note by its body, not its transient: the level 150 ms in, once a drum hit on the
  // same beat has mostly died away.
  const settled = sample(attackFrame + Math.round(0.15 * frameRate))
  if (settled < peakEnergy * SUSTAIN_BODY_RATIO) return clampSeconds(0.1)
  const threshold = settled * SUSTAIN_DROP_RATIO
  // The band's flux at the attack's own flux peak (the refined attack time sits a little later).
  const attackPosition = peaks[attackPeakIndex]?.position ?? attackFrame
  let attackFlux = 0
  for (let offset = -2; offset <= 2; offset++) attackFlux = Math.max(attackFlux, sampleAt(bandFlux, attackPosition + offset))
  const maxFrames = Math.ceil(SUSTAIN_MAX_SECONDS * frameRate)
  // Start just past the attack itself so the transient cannot count as sustain.
  const firstFrame = attackFrame + Math.max(1, Math.round(0.03 * frameRate))
  let end = firstFrame
  let nextPeak = attackPeakIndex + 1
  for (let step = 0; step < maxFrames; step++) {
    const frame = firstFrame + step
    if (sample(frame) < threshold) break
    while (nextPeak < peaks.length && peaks[nextPeak].position <= frame) {
      const peak = peaks[nextPeak]
      const restrike = sampleAt(bandFlux, peak.position) >= attackFlux * 0.6
      if (restrike || peak.strength >= attackStrength * 1.6) {
        return clampSeconds((peak.position - attackFrame) / frameRate)
      }
      nextPeak++
    }
    end = frame
  }
  return clampSeconds((end + 1 - attackFrame) / frameRate)
}

/** Energy per band per frame, fed one spectrum frame at a time; `finish` smooths it lightly. */
function bandEnergyByFrame(layout: StftLayout): { add: (f: number, magnitude: Float32Array) => void; finish: () => Float32Array[] } {
  const { frames, bins, bandOfBin, bandCount } = layout
  const energy = Array.from({ length: bandCount }, () => new Float32Array(frames))
  const add = (f: number, magnitude: Float32Array): void => {
    for (let k = 0; k < bins; k++) {
      const m = magnitude[k]
      energy[bandOfBin[k]][f] += m * m
    }
  }
  const finish = (): Float32Array[] => {
    for (const band of energy) {
      let previous = band[0]
      for (let f = 1; f < frames; f++) {
        previous = previous * 0.5 + band[f] * 0.5
        band[f] = previous
      }
    }
    return energy
  }
  return { add, finish }
}

const PEAK_OPTIONS = { delta: 0.06, windowSeconds: 0.28, minGapSeconds: 0.055 }
/** A stretch this long with no hits gets a second listen at its own volume. */
const QUIET_STRETCH_SECONDS = 6
/** Share of its own scale a quiet hit keeps as strength, so it never outranks the loud parts. */
const QUIET_STRENGTH = 0.5

/**
 * Peak picking works against the loudest part of the song, so a soft intro can come back empty:
 * After Dark's first 30 seconds gave two hits. Stretches with no hits are picked again against
 * their own loudest moment. Real silence is still removed later by the silent regions.
 */
function withQuietPeaks(peaks: ReturnType<typeof pickPeaks>, flux: Float32Array, frameRate: number): ReturnType<typeof pickPeaks> {
  const stretch = Math.round(QUIET_STRETCH_SECONDS * frameRate)
  const edges = [0, ...peaks.map((peak) => peak.index), flux.length]
  const found: ReturnType<typeof pickPeaks> = []
  for (let i = 1; i < edges.length; i++) {
    const from = edges[i - 1] + 1
    const to = edges[i] - 1
    if (to - from < stretch) continue
    const slice = flux.slice(from, to)
    let loudest = 0
    for (const value of slice) if (value > loudest) loudest = value
    if (loudest <= 1e-6) continue
    for (let f = 0; f < slice.length; f++) slice[f] /= loudest
    for (const peak of pickPeaks(slice, frameRate, PEAK_OPTIONS)) {
      found.push({ index: peak.index + from, position: peak.position + from, strength: peak.strength * QUIET_STRENGTH })
    }
  }
  return found.length === 0 ? peaks : [...peaks, ...found].sort((a, b) => a.index - b.index)
}

const TEXTURE_BANDS = 12
const TEXTURE_MIN_HZ = 60
const TEXTURE_MAX_HZ = 10000
const TEXTURE_RANGE_DB = 60

/** Log-band loudness at half the analysis frame rate, kept with the song for bar matching. */
function songTexture(
  layout: StftLayout,
  sampleRate: number,
  frameSize: number,
): { add: (f: number, magnitude: Float32Array) => void; finish: () => SongTexture } {
  const { frames, bins, frameRate } = layout
  const bandOfBin = new Int32Array(bins).fill(-1)
  for (let k = 1; k < bins; k++) {
    const hz = (k * sampleRate) / frameSize
    if (hz < TEXTURE_MIN_HZ || hz >= TEXTURE_MAX_HZ) continue
    bandOfBin[k] = Math.floor((Math.log(hz / TEXTURE_MIN_HZ) / Math.log(TEXTURE_MAX_HZ / TEXTURE_MIN_HZ)) * TEXTURE_BANDS)
  }
  // Two spectrum frames make one texture step; an odd last frame is left out.
  const count = Math.max(1, frames >> 1)
  const decibels = new Float32Array(count * TEXTURE_BANDS)
  const power = new Float64Array(TEXTURE_BANDS)
  let loudest = -Infinity
  const add = (f: number, magnitude: Float32Array): void => {
    const i = f >> 1
    if (i >= count) return
    for (let k = 0; k < bins; k++) {
      const band = bandOfBin[k]
      if (band >= 0) power[band] += magnitude[k] * magnitude[k]
    }
    if ((f & 1) === 0 && f !== frames - 1) return
    for (let band = 0; band < TEXTURE_BANDS; band++) {
      const value = 10 * Math.log10(power[band] + 1e-9)
      decibels[i * TEXTURE_BANDS + band] = value
      if (value > loudest) loudest = value
    }
    power.fill(0)
  }
  const finish = (): SongTexture => {
    const data = new Uint8Array(decibels.length)
    for (let i = 0; i < decibels.length; i++) {
      data[i] = Math.round(255 * Math.max(0, Math.min(1, 1 + (decibels[i] - loudest) / TEXTURE_RANGE_DB)))
    }
    return { rate: frameRate / 2, bands: TEXTURE_BANDS, data }
  }
  return { add, finish }
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
  const stftOptions = { frameSize, hopSize, bands }
  const layout = stftLayout(mono.length, sampleRate, stftOptions)
  const spectral = spectralFlux(layout)
  const energy = bandEnergyByFrame(layout)
  const textureSteps = songTexture(layout, sampleRate, frameSize)
  forEachSpectrum(
    mono,
    layout,
    stftOptions,
    (f, magnitude) => {
      spectral.add(f, magnitude)
      energy.add(f, magnitude)
      textureSteps.add(f, magnitude)
    },
    (f) => progress('Computing spectrum', 0.05 + f * 0.35),
  )

  progress('Detecting onsets', 0.45)
  const envelopes = computeOnsetEnvelopes(mono, layout, spectral, { frameSize, hopSize })
  const frameRate = envelopes.frameRate
  const peaks = withQuietPeaks(pickPeaks(envelopes.flux, frameRate, PEAK_OPTIONS), envelopes.flux, frameRate)

  // Fine energy envelope used to snap every onset onto its real attack (removes the analysis
  // window's group delay, which would otherwise bias notes late by tens of milliseconds).
  const fine = computeEnergyEnvelope(mono, sampleRate, { blockMs: 1, smoothMs: 10 })
  const bandEnergies = energy.finish()

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
        bandEnergies[dominant],
        envelopes.bandFlux[dominant],
        frameRate,
        peaks,
        peakIndex,
      ),
    })
  }

  progress('Estimating tempo', 0.7)
  const texture = textureSteps.finish()
  const polished = (result: ReturnType<typeof estimateTempo>): ReturnType<typeof estimateTempo> => {
    const fixedBpm = polishTempo(onsets, result.bpm)
    return fixedBpm === null ? result : estimateTempo(envelopes.flux, frameRate, onsets, { fixedBpm, keepBpm: true })
  }
  let tempoResult = polished(estimateTempo(envelopes.flux, frameRate, onsets, {}))
  const repeatingBpm = tempoFromRepeats(onsets, texture, duration, tempoResult.bpm, tempoResult.phase)
  if (repeatingBpm !== null) tempoResult = polished(estimateTempo(envelopes.flux, frameRate, onsets, { fixedBpm: repeatingBpm }))
  tempoResult = { ...tempoResult, phase: settleBeatLine(texture, onsets, tempoResult.bpm, tempoResult.phase, duration) }
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
  for (let t = tempoResult.phase - PERCEIVED_LEAD_SECONDS; t < duration; t += periodSeconds) {
    if (t >= 0) beatTimes.push(t)
  }

  const envelopeBuckets = 900
  const result: AnalysisResult = {
    version: ANALYSIS_VERSION,
    bpm: tempoResult.bpm,
    bpmConfidence: tempoResult.confidence,
    offset: tempoResult.phase - PERCEIVED_LEAD_SECONDS,
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
    texture,
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

