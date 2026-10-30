/**
 * Trim suggestions: finds regions of a song that are probably not worth playing.
 *
 * Everything here is derived from the analysis the app already computed (display envelope, onset
 * list, silent regions, sections) — no extra audio passes and no guessing beyond what those
 * signals can honestly support:
 *
 *  - silent / quiet runs at the start or end (count-ins, fades, room tone, long outros),
 *  - sparse non-percussive intros (free-time pickups, spoken intros),
 *  - sections that repeat with a very similar energy pattern (play one pass instead of two).
 *
 * A suggestion is only ever a proposal: the UI highlights it, the player decides whether to
 * remove it, and all trims are still just a [start, end] window that gameplay and the chart
 * generator both respect.
 */
import type { AnalysisResult } from '../core/types'
import { clamp } from '../core/math'

export type TrimSuggestionKind =
  | 'silence-intro'
  | 'silence-outro'
  | 'quiet-intro'
  | 'quiet-outro'
  | 'repeat-section'

export interface TrimSuggestion {
  id: string
  kind: TrimSuggestionKind
  /** Short label for chips ("Silent intro", "Repeated section ×2"). */
  label: string
  /** Honest one-liner about what was measured and why it is offered. */
  detail: string
  /** Region in seconds of the original audio. */
  start: number
  end: number
  /** What applying the suggestion does: shrink the window, or remove a section of it. */
  action: 'trim-start' | 'trim-end' | 'remove-section'
  /** 0..1 — how much the underlying signal supports the suggestion. */
  confidence: number
}

export interface TrimWindow {
  start: number
  end: number
}

export interface TrimAnalysisOptions {
  /** An edge quiet run must last at least this long to be offered. */
  minEdgeQuiet?: number
  /** Silence at an edge is only offered beyond this length. */
  minSilence?: number
  /** Sections longer than this can be considered for repeat detection. */
  minSection?: number
  /** Songs at least this long get their repeats pointed out even if short ones wouldn't be. */
  longSongSeconds?: number
  /** Maximum number of repeat suggestions. */
  maxRepeats?: number
  /** Pearson correlation above which two sections count as repeating. */
  repeatThreshold?: number
}

const DEFAULTS: Required<TrimAnalysisOptions> = {
  minEdgeQuiet: 4,
  minSilence: 1.2,
  minSection: 8,
  longSongSeconds: 300,
  maxRepeats: 2,
  repeatThreshold: 0.8,
}

export function analyzeTrimSuggestions(
  analysis: AnalysisResult,
  duration: number,
  options: TrimAnalysisOptions = {},
): TrimSuggestion[] {
  const opt = { ...DEFAULTS, ...options }
  if (!(duration > 1) || analysis.envelope.length < 4) return []

  const suggestions: TrimSuggestion[] = []
  const envelope = analysis.envelope
  const rate = analysis.envelopeRate > 0 ? analysis.envelopeRate : 1

  // A high percentile, not the median: percussive music sits near zero between hits, so the
  // median says nothing about how loud the loud parts actually are.
  const loudLevel = percentile(envelope, 0.95)
  const quietThreshold = Math.max(0.05, loudLevel * 0.22)
  if (loudLevel <= 0.02) return [] // the whole song is near-silent; trimming cannot fix that

  /* ---------------------------------------------------------------- intro */

  const introEnd = leadingQuietEnd(envelope, rate, quietThreshold)
  const introSilent =
    introEnd > 0 && mostlySilent(analysis, 0, introEnd) && hasEdgeSilence(analysis, 'start', duration, opt.minSilence)
  // Verified digital silence is dead air from ~1 s; a merely quiet run needs more evidence before
  // the chip is worth showing, because plenty of songs open quietly on purpose.
  if (introEnd >= (introSilent ? opt.minSilence : opt.minEdgeQuiet)) {
    if (introSilent) {
      suggestions.push({
        id: 'silence-intro',
        kind: 'silence-intro',
        label: 'Silent intro',
        detail: `${fmt(introEnd)} of near-silence before any music starts. Removing it wastes nothing.`,
        start: 0,
        end: introEnd,
        action: 'trim-start',
        confidence: 0.92,
      })
    } else {
      const density = onsetDensity(analysis, 0, introEnd)
      const spoken = density < 0.7
      suggestions.push({
        id: 'quiet-intro',
        kind: 'quiet-intro',
        label: spoken ? 'Quiet or spoken intro' : 'Quiet intro',
        detail:
          `${fmt(introEnd)} sit below ${Math.round((quietThreshold / Math.max(1e-6, loudLevel)) * 100)}% of the song's loud level` +
          (spoken
            ? ` with very little percussive content (${density.toFixed(2)} onsets/s) — possibly speech, a count-in or a free-time pickup.`
            : `. It may be a fade or a build-up; remove it if you would rather start on the beat.`),
        start: 0,
        end: introEnd,
        action: 'trim-start',
        confidence: spoken ? 0.55 : 0.65,
      })
    }
  }

  /* ----------------------------------------------------------------- outro */

  const outroStart = trailingQuietStart(envelope, rate, quietThreshold)
  const outroSilent =
    duration - outroStart > 0 && mostlySilent(analysis, outroStart, duration) && hasEdgeSilence(analysis, 'end', duration, opt.minSilence)
  if (duration - outroStart >= (outroSilent ? opt.minSilence : opt.minEdgeQuiet)) {
    if (outroSilent) {
      suggestions.push({
        id: 'silence-outro',
        kind: 'silence-outro',
        label: 'Silent outro',
        detail: `${fmt(duration - outroStart)} of near-silence after the music ends.`,
        start: outroStart,
        end: duration,
        action: 'trim-end',
        confidence: 0.92,
      })
    } else {
      const density = onsetDensity(analysis, outroStart, duration)
      suggestions.push({
        id: 'quiet-outro',
        kind: 'quiet-outro',
        label: density < 0.7 ? 'Quiet or spoken outro' : 'Quiet outro',
        detail:
          `The last ${fmt(duration - outroStart)} sit well below the song's loud level` +
          (density < 0.7
            ? ` with almost no percussive hits (${density.toFixed(2)} onsets/s) — likely a fade-out, room noise or talking.`
            : ` — a fade or an outro; remove it to end on the last full section.`),
        start: outroStart,
        end: duration,
        action: 'trim-end',
        confidence: density < 0.7 ? 0.55 : 0.65,
      })
    }
  }

  /* --------------------------------------------------------------- repeats */

  const repeats = findRepeatedSections(analysis, duration, opt)
  for (const repeat of repeats) suggestions.push(repeat)

  return suggestions
}

/** Apply one window suggestion. Always returns a valid window inside [0, duration]. */
export function applyTrimSuggestion(
  window: TrimWindow,
  suggestion: TrimSuggestion,
  duration: number,
): TrimWindow {
  const minSpan = 2
  if (suggestion.action === 'trim-start') {
    const start = clamp(suggestion.end + 0.25, 0, duration - minSpan)
    return { start, end: Math.max(start + minSpan, window.end) }
  }
  if (suggestion.action === 'trim-end') {
    const end = clamp(suggestion.start - 0.2, minSpan, duration)
    return { start: Math.min(window.start, end - minSpan), end }
  }
  // `remove-section` is a cut, not a window change: the trim UI turns it into an entry in the cut
  // list (see `barSnappedCut`) and the engine splices it out. The window stays as it is.
  return window
}

export interface AutoTrimResult {
  window: TrimWindow
  /** Which suggestions were applied, for the UI toast. */
  applied: TrimSuggestion[]
}

/**
 * Find near-silence at the very edges of the waveform. The 0..255 peak buckets are absolute
 * amplitudes, so this is not fooled by a quiet *musical* intro the way an energy percentile can
 * be: only buckets at or below the noise floor count. Returns null when no trustworthy edge
 * silence exists.
 */
export interface EdgeSilence {
  /** Seconds of audio before the first real sound. */
  leadingEnd: number
  /** Seconds into the audio where the last real sound ends. */
  trailingStart: number
  /** Peak-byte threshold used, for debugging and tests. */
  threshold: number
}

export function detectEdgeSilenceFromPeaks(peaks: Uint8Array, duration: number): EdgeSilence | null {
  if (!(duration > 1) || peaks.length === 0) return null
  let maxPeak = 0
  for (let i = 0; i < peaks.length; i++) if (peaks[i] > maxPeak) maxPeak = peaks[i]
  if (maxPeak <= 2) return null // the file is silent or unreadable; trimming cannot help
  // Absolute amplitude, not a fraction of the song's loudness: this only catches digital silence
  // / dither-level noise, never a quiet verse, fade-in or spoken intro.
  const threshold = Math.max(2, Math.round(maxPeak * 0.004))
  let first = 0
  while (first < peaks.length && peaks[first] <= threshold) first++
  let last = peaks.length - 1
  while (last >= 0 && peaks[last] <= threshold) last--
  if (first > last) return null
  const bucketSeconds = duration / peaks.length
  return {
    leadingEnd: first * bucketSeconds,
    trailingStart: (last + 1) * bucketSeconds,
    threshold,
  }
}

/**
 * One-click auto trim. It only removes near-silence at the two edges and always leaves a short
 * musical tail. No quiet intro, verse, fade or repeated section is ever selected: if the waveform
 * does not prove an edge is silent, the song plays whole.
 */
export function autoTrimWindow(analysis: AnalysisResult, duration: number, peaks?: Uint8Array): AutoTrimResult {
  // `analysis` is accepted for call-site compatibility (and older persisted callers); the peak
  // waveform is the authoritative signal because it measures absolute silence.
  void analysis
  const edges = peaks ? detectEdgeSilenceFromPeaks(peaks, duration) : null
  if (!edges || !(duration > 2)) {
    return { window: { start: 0, end: duration }, applied: [] }
  }

  const applied: TrimSuggestion[] = []
  let start = 0
  let end = duration
  // Keep a 150 ms run-up before the first sound so the song does not begin on a hard cut.
  if (edges.leadingEnd >= 1) {
    start = clamp(edges.leadingEnd - 0.15, 0, duration - 2)
    applied.push({
      id: 'silence-intro',
      kind: 'silence-intro',
      label: 'Silent start',
      detail: `${fmt(edges.leadingEnd)} of near-silence before the music starts.`,
      start: 0,
      end: edges.leadingEnd,
      action: 'trim-start',
      confidence: 0.95,
    })
  }
  // Do not stop on the last note: play 1.2 s of the file's own tail. This is what makes the
  // ending feel like an ending instead of a dialog appearing on top of the final chord.
  if (duration - edges.trailingStart >= 1.2) {
    end = clamp(edges.trailingStart + 1.2, start + 2, duration)
    applied.push({
      id: 'silence-outro',
      kind: 'silence-outro',
      label: 'Silent end',
      detail: `${fmt(duration - edges.trailingStart)} of near-silence after the music ends.`,
      start: edges.trailingStart,
      end: duration,
      action: 'trim-end',
      confidence: 0.95,
    })
  }

  return { window: normalizeTrimWindow({ start, end }, duration), applied }
}

/** Sanitize a window against a duration; a window that would leave almost nothing returns the full song. */
export function normalizeTrimWindow(window: TrimWindow | null | undefined, duration: number): TrimWindow {
  if (!window || !Number.isFinite(window.start) || !Number.isFinite(window.end)) return { start: 0, end: duration }
  const start = clamp(window.start, 0, duration)
  const end = clamp(window.end, 0, duration)
  if (end - start < 1) return { start: 0, end: duration }
  return { start, end }
}

/* ------------------------------------------------------------------ helper */

function fmt(seconds: number): string {
  const s = Math.max(0, seconds)
  const minutes = Math.floor(s / 60)
  const rest = s - minutes * 60
  return minutes > 0 ? `${minutes}:${rest.toFixed(1).padStart(4, '0')}` : `${rest.toFixed(1)} s`
}

function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) return 0
  const sorted = Array.from(values).sort((a, b) => a - b)
  const index = clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1)
  return sorted[index]
}

function frameMean(envelope: Float32Array, rate: number, start: number, end: number): number {
  const i0 = clamp(Math.floor(start * rate), 0, envelope.length)
  const i1 = clamp(Math.ceil(end * rate), i0, envelope.length)
  if (i1 <= i0) return 0
  let sum = 0
  for (let i = i0; i < i1; i++) sum += envelope[i]
  return sum / (i1 - i0)
}

/**
 * Whether frame `i` is a hit that ends the quiet run.
 *
 * Percussive music is impulse-like: between hits the envelope sits at zero, so an average over a
 * lookahead would call a drum beat "quiet". A frame ends the run when it clears the threshold and
 * either the hit is clearly loud (twice the threshold) or another hit follows within half a
 * second — so a lone breath or click inside a silent lead-in keeps the run alive.
 */
function hitForward(envelope: Float32Array, rate: number, i: number, threshold: number): boolean {
  const value = envelope[i]
  if (value < threshold) return false
  if (value >= threshold * 2) return true
  const span = Math.max(1, Math.round(0.5 * rate))
  const j1 = Math.min(envelope.length, i + span)
  for (let j = i + 1; j < j1; j++) {
    if (envelope[j] >= threshold) return true
  }
  return false
}

/** Mirror of `hitForward` for the trailing edge: the hit must start before frame `i`. */
function hitBackward(envelope: Float32Array, rate: number, i: number, threshold: number): boolean {
  const value = envelope[i]
  if (value < threshold) return false
  if (value >= threshold * 2) return true
  const span = Math.max(1, Math.round(0.5 * rate))
  const j0 = Math.max(0, i - span + 1)
  for (let j = j0; j < i; j++) {
    if (envelope[j] >= threshold) return true
  }
  return false
}

/** End of the initial quiet run. */
function leadingQuietEnd(envelope: Float32Array, rate: number, threshold: number): number {
  for (let i = 0; i < envelope.length; i++) {
    if (hitForward(envelope, rate, i, threshold)) return i / rate
  }
  return envelope.length / rate
}

/** Start of the final quiet run. */
function trailingQuietStart(envelope: Float32Array, rate: number, threshold: number): number {
  for (let i = envelope.length - 1; i >= 0; i--) {
    if (hitBackward(envelope, rate, i, threshold)) return (i + 1) / rate
  }
  return 0
}

function mostlySilent(analysis: AnalysisResult, start: number, end: number): boolean {
  if (end - start < 0.2) return false
  let covered = 0
  for (const region of analysis.silentRegions) {
    const overlap = Math.min(end, region.end) - Math.max(start, region.start)
    if (overlap > 0) covered += overlap
  }
  return covered >= (end - start) * 0.6
}

function hasEdgeSilence(analysis: AnalysisResult, edge: 'start' | 'end', duration: number, minSilence: number): boolean {
  for (const region of analysis.silentRegions) {
    if (edge === 'start' && region.start <= 0.5 && region.end - Math.max(0, region.start) >= minSilence) return true
    if (edge === 'end' && region.end >= duration - 0.5 && region.end - region.start >= minSilence) return true
  }
  return false
}

function onsetDensity(analysis: AnalysisResult, start: number, end: number): number {
  const span = Math.max(0.001, end - start)
  let count = 0
  for (const onset of analysis.onsets) {
    if (onset.time >= start && onset.time < end) count++
  }
  return count / span
}

/* ------------------------------------------------------------------ bars */

/** Length of one bar in seconds for the analysed grid. */
export function secondsPerBar(analysis: Pick<AnalysisResult, 'bpm' | 'beatsPerBar'>): number {
  if (!(analysis.bpm > 0)) return 0
  return (60 / analysis.bpm) * Math.max(1, analysis.beatsPerBar)
}

/**
 * Snap an interval to whole bars of the analysed grid. A cut that removes an integer number of
 * bars leaves the beat grid continuous across the splice, so the tempo map and the generated
 * charts stay exactly on-grid after the join. Returns null when the result would be under one bar.
 */
export function barSnappedCut(
  analysis: Pick<AnalysisResult, 'bpm' | 'beatsPerBar' | 'offset'>,
  start: number,
  end: number,
): { start: number; end: number } | null {
  const bar = secondsPerBar(analysis)
  if (!(bar > 0.05)) return null
  const snappedStart = analysis.offset + Math.round((start - analysis.offset) / bar) * bar
  const snappedEnd = analysis.offset + Math.round((end - analysis.offset) / bar) * bar
  if (snappedEnd - snappedStart < bar - 1e-6) return null
  return { start: Math.max(0, snappedStart), end: snappedEnd }
}

/* ---------------------------------------------------------------- repeats */

/**
 * Find pairs of sections whose onset envelopes are strongly correlated. This is a coarse
 * self-similarity check (energy pattern, not melody), so the label says "similar", not "identical".
 */
export function findRepeatedSections(
  analysis: AnalysisResult,
  duration: number,
  options: TrimAnalysisOptions = {},
): TrimSuggestion[] {
  const opt = { ...DEFAULTS, ...options }
  const envelope = analysis.envelope
  const rate = analysis.envelopeRate > 0 ? analysis.envelopeRate : 1
  if (envelope.length < rate * 12) return []

  // Candidate sections: musical, long enough, not the quiet edges (those have their own chips).
  const candidates = analysis.sections
    .filter((section) => section.kind !== 'silent')
    .map((section) => ({ start: clamp(section.start, 0, duration), end: clamp(section.end, 0, duration) }))
    .filter((section) => section.end - section.start >= opt.minSection)
    .slice(0, 10)

  const found: { a: { start: number; end: number }; b: { start: number; end: number }; corr: number }[] = []
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]
      const b = candidates[j]
      const lenA = a.end - a.start
      const lenB = b.end - b.start
      const ratio = lenA / lenB
      if (ratio < 0.7 || ratio > 1.43) continue
      const corr = sliceCorrelation(envelope, rate, a.start, a.end, b.start, b.end)
      if (corr >= opt.repeatThreshold) found.push({ a, b, corr })
    }
  }
  found.sort((x, y) => y.corr - x.corr)

  const chosen: typeof found = []
  const usedStarts = new Set<number>()
  for (const pair of found) {
    const keyA = Math.round(pair.a.start)
    const keyB = Math.round(pair.b.start)
    if (usedStarts.has(keyA) || usedStarts.has(keyB)) continue
    usedStarts.add(keyA)
    usedStarts.add(keyB)
    chosen.push(pair)
    if (chosen.length >= opt.maxRepeats) break
  }

  return chosen.flatMap((pair, index) => {
    const keep = pair.a
    const other = pair.b
    // Removing the second pass keeps the arrangement flowing into whatever follows it, and the
    // cut is snapped to whole bars so the beat grid survives the splice.
    const cut = barSnappedCut(analysis, other.start, other.end)
    if (!cut) return []
    const long = duration >= opt.longSongSeconds
    const bar = secondsPerBar(analysis)
    const bars = Math.max(1, Math.round((cut.end - cut.start) / bar))
    return [
      {
        id: `repeat-${index + 1}`,
        kind: 'repeat-section' as const,
        label: `Repeated section ×2`,
        detail:
          `The part around ${fmt(keep.start)}–${fmt(keep.end)} matches the one at ${fmt(other.start)}–${fmt(other.end)} ` +
          `with ${Math.round(pair.corr * 100)}% pattern similarity (energy pattern, not melody). ` +
          `Removing the second pass (${fmt(cut.start)}–${fmt(cut.end)}, ${bars} ${bars === 1 ? 'bar' : 'bars'}) ` +
          `splices whole bars, so the beat grid stays intact${long ? ` — this song is ${fmt(duration)} long` : ''}.`,
        start: cut.start,
        end: cut.end,
        action: 'remove-section' as const,
        confidence: clamp((pair.corr - 0.7) / 0.3, 0.2, 0.95),
      },
    ]
  })
}

/** Pearson correlation between two window slices, resampled to a common frame count. */
function sliceCorrelation(
  envelope: Float32Array,
  rate: number,
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number {
  const frames = clamp(Math.round(Math.min(aEnd - aStart, bEnd - bStart) * rate), 8, 1200)
  const a = resample(envelope, rate, aStart, aEnd, frames)
  const b = resample(envelope, rate, bStart, bEnd, frames)
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < frames; i++) {
    meanA += a[i]
    meanB += b[i]
  }
  meanA /= frames
  meanB /= frames
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < frames; i++) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    dot += da * db
    normA += da * da
    normB += db * db
  }
  if (normA <= 1e-9 || normB <= 1e-9) return 0
  return dot / Math.sqrt(normA * normB)
}

function resample(envelope: Float32Array, rate: number, start: number, end: number, frames: number): Float32Array {
  const out = new Float32Array(frames)
  const span = Math.max(1e-6, end - start)
  for (let i = 0; i < frames; i++) {
    const t = start + (span * i) / frames
    const index = Math.floor(t * rate)
    out[i] = envelope[clamp(index, 0, envelope.length - 1)]
  }
  return out
}
