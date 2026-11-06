/**
 * Library: turning a picked audio file into a stored song with generated charts.
 *
 * This is the only place that assembles a `SongMeta`, so the rules about what is persisted live
 * here: metadata, peaks, the honest analysis summary and the generated charts are saved; the
 * decoded audio buffer only lives in memory (and in IndexedDB solely when the user opted in).
 */
import type { AnalysisResult, Chart, Difficulty, SongMeta } from '../core/types'
import { DIFFICULTIES } from '../core/types'
import { planForMeta, type EditPlan } from '../core/edit'
import { decodeAudioFile } from '../audio/engine'
import { ANALYSIS_VERSION, downmixMono } from '../audio/analyze'
import { autoTrimWindow } from '../audio/trim'
import { readSongTags } from '../audio/tags'
import { toPeakBytes, downsample, normalize } from '../core/math'
import { createId, hashString } from '../core/rng'
import { GENERATOR_VERSION, generateAllDifficulties } from '../chart/generate'
import { TimingMap } from '../chart/timing'
import { AnalysisClient } from '../workers/analysisClient'
import { openDb } from './db'
import {
  listCharts,
  listSongs,
  loadAnalysis,
  loadAudio,
  saveAnalysis,
  saveAudio,
  saveCharts,
  saveSong,
} from './repository'

export interface ImportProgress {
  stage: string
  fraction: number
}

export interface SongBundle {
  meta: SongMeta
  charts: Chart[]
  analysis: AnalysisResult | null
  /** Decoded audio for playback. Not persisted; null when the file must be re-selected. */
  buffer: AudioBuffer | null
  /** The import could not keep a copy of the audio (storage full): the file is needed next time. */
  audioNotSaved?: boolean
}

/**
 * Ask the browser not to clear the library under storage pressure (and Safari's 7-day rule for
 * sites). Asked once there is something worth keeping; Chrome decides silently, Firefox may ask.
 */
async function keepStorage(): Promise<void> {
  try {
    if (!navigator.storage?.persist || (await navigator.storage.persisted())) return
    await navigator.storage.persist()
  } catch {
    /* not supported or refused: nothing to do */
  }
}

let storageProbe: Promise<boolean> | null = null
/**
 * Whether the local database opens at all. A blocked one (private windows, a portal iframe with
 * third-party storage off) must not stop play: the song then lives in memory for this visit.
 */
export function storageWorks(): Promise<boolean> {
  storageProbe ??= openDb().then(
    () => true,
    () => {
      storageProbe = null
      return false
    },
  )
  return storageProbe
}

/** Storage full: the browser refused to write more. */
export function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
}

export function titleFromFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.[a-z0-9]{2,5}$/i, '')
  const cleaned = withoutExt.replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
  // Phones can hand over a content id instead of the real name ("INBOUND3122…", "1000012345").
  if (/^(inbound|document|audio|msf:?)?[\s:-]*\d{5,}$/i.test(cleaned)) return 'Untitled song'
  return cleaned.length > 0 ? cleaned : fileName
}

export function buildSongMeta(input: {
  songId: string
  title: string
  artist: string
  file: File
  buffer: AudioBuffer
  /** Waveform peaks, taken from the mono mix before it went to the analyser. */
  peaks: Uint8Array
  analysis: AnalysisResult
  audioCached: boolean
}): SongMeta {
  const { songId, title, artist, file, buffer, peaks, analysis, audioCached } = input
  return {
    id: songId,
    title,
    artist,
    fileName: file.name,
    fileSize: file.size,
    lastModified: file.lastModified,
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    peaks,
    envelope: downsample(normalize(analysis.envelope), 700),
    analysis: summarizeAnalysis(analysis),
    createdAt: Date.now(),
    lastPlayedAt: Date.now(),
    audioCached,
  }
}

const reanalyses = new Map<string, Promise<AnalysisResult>>()

/** Analyse a saved song's audio again and store the result. Concurrent callers share one run. */
function reanalyze(songId: string, buffer: AudioBuffer): Promise<AnalysisResult> {
  const running = reanalyses.get(songId)
  if (running) return running
  const job = (async () => {
    const client = new AnalysisClient()
    try {
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
      const result = await client.analyze(downmixMono(channels, buffer.length), buffer.sampleRate, {
        owned: buffer.numberOfChannels > 1,
      })
      await saveAnalysis(songId, result)
      return result
    } finally {
      client.dispose()
    }
  })()
  reanalyses.set(songId, job)
  void job.finally(() => reanalyses.delete(songId)).catch(() => undefined)
  return job
}

/** The beat grid charts are built on: the player's correction if there is one, else the analysis. */
export function beatOf(meta: Pick<SongMeta, 'beatFix' | 'analysis'>): { bpm: number; offset: number } {
  return meta.beatFix ?? { bpm: meta.analysis.bpm, offset: meta.analysis.offset }
}

/** Everything the app persists about the analysis (the full result stays in memory only). */
export function summarizeAnalysis(analysis: AnalysisResult): SongMeta['analysis'] {
  return {
    version: analysis.version,
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    offset: analysis.offset,
    phaseConfidence: analysis.phaseConfidence,
    gridResidualMs: analysis.gridResidualMs,
    candidates: analysis.candidates.slice(0, 6),
    beats: analysis.beats,
    beatsPerBar: analysis.beatsPerBar,
    sections: analysis.sections,
    silentRegions: analysis.silentRegions,
    limitations: analysis.limitations,
  }
}

export interface ImportSongOptions {
  analysisClient: AnalysisClient
  onProgress?: (progress: ImportProgress) => void
  onStage?: (stage: string) => void
  signal?: AbortSignal
  /** Persist the decoded file bytes so the song can be replayed without re-selecting it. */
  rememberAudio?: boolean
  title?: string
  artist?: string
  difficulties?: Difficulty[]
}

/**
 * Full import path: decode → analyse (worker) → generate 4 charts → persist metadata + charts.
 *
 * Re-importing the same file is an update, not a new song: the stable id, saved trim and existing
 * charts are kept, so the arrows do not change just because the file was loaded again.
 */
export async function importSongFromFile(file: File, options: ImportSongOptions): Promise<SongBundle> {
  const { analysisClient, onProgress, onStage } = options
  onStage?.('Decoding audio')
  onProgress?.({ stage: 'Decoding audio', fraction: 0 })
  const buffer = await decodeAudioFile(file)
  if (options.signal?.aborted) throw new DOMException('Import cancelled', 'AbortError')

  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  const mono = downmixMono(channels, buffer.length)
  // `downmixMono` returns a fresh array for multi-channel input; for a mono file it returns the
  // AudioBuffer's own channel data, which must not be transferred away.
  const owned = buffer.numberOfChannels > 1
  // Taken now: an owned mix is handed to the worker and gone afterwards.
  const peaks = toPeakBytes(mono, 1400)

  const analysis = await analysisClient.analyze(mono, buffer.sampleRate, {
    owned,
    signal: options.signal,
    onProgress: (stage, fraction) => onProgress?.({ stage, fraction }),
  })
  if (options.signal?.aborted) throw new DOMException('Import cancelled', 'AbortError')

  onStage?.('Generating charts')
  onProgress?.({ stage: 'Generating charts', fraction: 0.97 })
  const canSave = await storageWorks()
  const existing = (canSave ? await listSongs() : []).find(
    (song) => song.fileName === file.name && song.fileSize === file.size && song.lastModified === file.lastModified,
  )
  // Re-attaching the same file keeps a title or artist the player typed in.
  // The file's own tags beat its name: phones can name a picked file "INBOUND3122…".
  const tags = existing ? {} : await readSongTags(file)
  const title = options.title?.trim() || existing?.title || tags.title || titleFromFileName(file.name)
  const artist = options.artist?.trim() || existing?.artist || tags.artist || ''
  // Stable id derived from the file identity instead of a clock/random pair. Two different files
  // colliding on all three fields is not realistic; the same file always lands on the same row.
  const songId = existing?.id ?? `song_${hashString(`${file.name}|${file.size}|${file.lastModified}`).toString(36)}`
  const timing = existing?.beatFix ? TimingMap.single(existing.beatFix.bpm, existing.beatFix.offset) : TimingMap.single(analysis.bpm, analysis.offset)
  const existingCharts = existing && canSave ? await listCharts(existing.id) : []
  const remember = options.rememberAudio ?? true
  const meta = buildSongMeta({ songId, title, artist, file, buffer, peaks, analysis, audioCached: remember })
  const auto = autoTrimWindow(analysis, buffer.duration, meta.peaks)
  if (existing) {
    // Preserve everything the player chose that is not part of a fresh analysis.
    meta.createdAt = existing.createdAt
    meta.lastPlayedAt = existing.lastPlayedAt
    if (existing.preferredDifficulty !== undefined) meta.preferredDifficulty = existing.preferredDifficulty
    if (existing.chartVariant !== undefined) meta.chartVariant = existing.chartVariant
    // The trim on record is the player's (or an earlier automatic one they have played with):
    // re-importing the same file never moves it.
    if (existing.trimStart !== undefined) meta.trimStart = existing.trimStart
    if (existing.trimEnd !== undefined) meta.trimEnd = existing.trimEnd
    if (existing.trimCuts !== undefined) meta.trimCuts = existing.trimCuts
    if (existing.trimManual) meta.trimManual = true
    if (existing.beatFix) meta.beatFix = existing.beatFix
  } else {
    // Trim conservatively on the first import: only waveform-verified near-silence at the edges.
    // A quiet intro is never cut just because it is quiet.
    if (auto.window.start > 0.05) meta.trimStart = auto.window.start
    if (auto.window.end < buffer.duration - 0.05) meta.trimEnd = auto.window.end
  }
  // Keep the arrows the player already has. "New arrows" in song options is the explicit way to
  // ask for a different variation. A generator upgrade is the one exception: old charts would
  // otherwise keep the exact timing/chord/hold behaviour this version just fixed. Hand-edited
  // charts are never replaced.
  const requested = options.difficulties ?? [...DIFFICULTIES]
  const regenerate = new Set<Difficulty>()
  for (const difficulty of requested) {
    const chart = existingCharts.find((c) => c.difficulty === difficulty)
    if (!chart) regenerate.add(difficulty)
    else if (!chart.edited && chart.generator.version !== GENERATOR_VERSION) regenerate.add(difficulty)
  }
  let charts = existingCharts.filter((chart) => requested.includes(chart.difficulty))
  if (regenerate.size > 0) {
    const regenerated = generateAllDifficulties({
      analysis,
      timing,
      duration: buffer.duration,
      songId,
      title,
      difficulties: [...regenerate],
      edit: planForMeta(meta),
      options: { salt: meta.chartVariant ?? 0 },
    })
    const byDifficulty = new Map(regenerated.map((chart) => [chart.difficulty, chart]))
    charts = requested
      .map(
        (difficulty) =>
          byDifficulty.get(difficulty) ?? existingCharts.find((chart) => chart.difficulty === difficulty),
      )
      .filter((chart): chart is Chart => chart !== undefined)
  }

  // The song row goes last, so a failure part way never leaves a song in the library that has no
  // analysis or charts. A full disk only costs the stored copy of the audio, not the song.
  let audioNotSaved = false
  if (!canSave) {
    onProgress?.({ stage: 'Done', fraction: 1 })
    return { meta: { ...meta, audioCached: false }, charts, analysis, buffer, audioNotSaved: true }
  }
  if (remember) {
    try {
      await saveAudio(songId, file)
    } catch (error) {
      if (!isQuotaError(error)) throw error
      audioNotSaved = true
      meta.audioCached = false
    }
  }
  await saveAnalysis(songId, analysis)
  await saveCharts(charts)
  await saveSong(meta)

  onProgress?.({ stage: 'Done', fraction: 1 })
  void keepStorage()
  return { meta, charts, analysis, buffer, ...(audioNotSaved ? { audioNotSaved } : {}) }
}

/**
 * Regenerate charts from an existing analysis with corrected timing (BPM/offset are the two
 * numbers a player can meaningfully correct by ear) and/or a playback edit (trim window + cuts).
 */
export async function regenerateCharts(input: {
  analysis: AnalysisResult
  duration: number
  songId: string
  title: string
  bpm: number
  offset: number
  difficulties?: Difficulty[]
  edit?: EditPlan | null
  /** Increment for a new arrow variation; omit to reproduce the current chart exactly. */
  salt?: number
  /** The song's current charts. Hand-edited ones are kept as they are, unless `replaceEdited`. */
  existing?: Chart[]
  replaceEdited?: boolean
}): Promise<Chart[]> {
  const timing = TimingMap.single(input.bpm, input.offset)
  const edited = input.replaceEdited ? [] : (input.existing ?? []).filter((chart) => chart.edited)
  // A hand-edited chart that gets rebuilt is kept as the new chart's previous version.
  const replaced = new Map((input.replaceEdited ? (input.existing ?? []).filter((chart) => chart.edited) : []).map((chart) => [chart.difficulty, chart]))
  const generated = generateAllDifficulties({
    analysis: input.analysis,
    timing,
    duration: input.duration,
    songId: input.songId,
    title: input.title,
    difficulties: (input.difficulties ?? [...DIFFICULTIES]).filter(
      (difficulty) => !edited.some((chart) => chart.difficulty === difficulty),
    ),
    edit: input.edit ?? null,
    options: { salt: input.salt ?? 0 },
  }).map((chart) => {
    const old = replaced.get(chart.difficulty)
    if (!old) return chart
    const { previous: _drop, ...rest } = old
    return { ...chart, previous: rest }
  })
  await saveCharts(generated)
  return [...generated, ...edited].sort(
    (a, b) => DIFFICULTIES.indexOf(a.difficulty) - DIFFICULTIES.indexOf(b.difficulty),
  )
}

/**
 * Persist a song's playable window and removed sections. `null` (or a window that covers the whole
 * file with no cuts) removes the trim entirely, which is the canonical "no trim" state.
 *
 * Charts are NOT touched here: the caller regenerates them with the matching `EditPlan`, because
 * only the caller still has the full analysis in memory.
 */
export async function setSongTrim(songId: string, trim: TrimDraft | null): Promise<SongMeta | null> {
  const songs = await listSongs()
  const meta = songs.find((song) => song.id === songId)
  if (!meta) return null
  const next: SongMeta = { ...meta, trimManual: true }
  const coversAll = !trim || (trim.start <= 0.001 && trim.end >= meta.duration - 0.001 && trim.cuts.length === 0)
  if (coversAll) {
    delete next.trimStart
    delete next.trimEnd
    delete next.trimCuts
  } else {
    const start = Math.max(0, Math.min(trim.start, meta.duration))
    const end = Math.max(start + 1, Math.min(trim.end, meta.duration))
    next.trimStart = start
    next.trimEnd = end
    next.trimCuts = trim.cuts
      .map((cut) => ({ start: Math.max(start, Math.min(cut.start, end)), end: Math.max(start, Math.min(cut.end, end)) }))
      .filter((cut) => cut.end - cut.start > 0.05)
      .sort((a, b) => a.start - b.start)
  }
  await saveSong(next)
  return next
}

/** What the trim UI edits: a playable window plus whole sections to splice out. */
export interface TrimDraft {
  start: number
  end: number
  cuts: { start: number; end: number }[]
}

/** Current trim of a song as an editable draft. */
export function trimDraftFor(meta: SongMeta): TrimDraft {
  return {
    start: meta.trimStart ?? 0,
    end: meta.trimEnd ?? meta.duration,
    cuts: (meta.trimCuts ?? []).map((cut) => ({ start: cut.start, end: cut.end })),
  }
}

export function sameTrim(a: TrimDraft, b: TrimDraft): boolean {
  if (a.cuts.length !== b.cuts.length) return false
  if (Math.abs(a.start - b.start) > 1e-3 || Math.abs(a.end - b.end) > 1e-3) return false
  return a.cuts.every((cut, i) => Math.abs(cut.start - b.cuts[i].start) <= 1e-3 && Math.abs(cut.end - b.cuts[i].end) <= 1e-3)
}

/** Everything the library needs for one song: metadata, charts, and audio if it can be obtained. */
/** One load per song at a time: the menu music and the song screen asked at the same moment and decoded twice. */
const bundleLoads = new Map<string, Promise<SongBundle | null>>()

export function loadSongBundle(songId: string, options: { requireAudio?: boolean } = {}): Promise<SongBundle | null> {
  const running = bundleLoads.get(songId)
  if (running) return running
  const load = loadSongBundleNow(songId, options).finally(() => bundleLoads.delete(songId))
  bundleLoads.set(songId, load)
  return load
}

async function loadSongBundleNow(songId: string, options: { requireAudio?: boolean } = {}): Promise<SongBundle | null> {
  const songs = await listSongs()
  let meta = songs.find((song) => song.id === songId)
  if (!meta) return null
  let [charts, analysis] = await Promise.all([listCharts(songId), loadAnalysis(songId)])
  let buffer: AudioBuffer | null = null
  if (meta.audioCached) {
    const file = await loadAudio(songId)
    if (file) {
      try {
        buffer = await decodeAudioFile(file)
      } catch {
        buffer = null
      }
    }
  }
  // An analyser update re-reads the saved audio once, so old songs get the new measurements
  // (hold lengths, for one). The regeneration below then rebuilds their unedited charts.
  let reanalysed = false
  if (analysis && buffer && analysis.version !== ANALYSIS_VERSION) {
    analysis = await reanalyze(songId, buffer)
    reanalysed = true
    const nextMeta: SongMeta = { ...meta, analysis: summarizeAnalysis(analysis) }
    await saveSong(nextMeta)
    meta = nextMeta
  }
  if (analysis) {
    // A saved trim is never re-run here: it may be the player's own (the trim tool on the song
    // screen), and an automatic trim was already checked when the song was imported.
    // A generator update is the one time we replace generated arrows without the player pressing
    // "New arrows". Edited charts are never overwritten.
    const stale = charts
      .filter((chart) => !chart.edited && chart.generator.version !== GENERATOR_VERSION)
      .map((chart) => chart.difficulty)
    const difficulties =
      reanalysed ? charts.filter((chart) => !chart.edited).map((chart) => chart.difficulty) : stale
    if (difficulties.length > 0) {
      const regenerated = generateAllDifficulties({
        analysis,
        timing: TimingMap.single(beatOf(meta).bpm, beatOf(meta).offset),
        duration: meta.duration,
        songId: meta.id,
        title: meta.title,
        difficulties,
        edit: planForMeta(meta),
        options: { salt: meta.chartVariant ?? 0 },
      })
      await saveCharts(regenerated)
      const byDifficulty = new Map(regenerated.map((chart) => [chart.difficulty, chart]))
      charts = charts.map((chart) => byDifficulty.get(chart.difficulty) ?? chart)
    }
  }
  if (options.requireAudio && !buffer) {
    return { meta, charts, analysis, buffer: null }
  }
  return { meta, charts, analysis, buffer }
}
