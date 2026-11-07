/**
 * Repository: the app-facing storage API.
 *
 * Screens never touch IndexedDB directly; they call these functions, which own the invariants:
 *  - deleting a song deletes its charts, cached audio and scores in one go;
 *  - charts are always stored sorted and sanitized;
 *  - scores are stored with the song title so the history list never needs a join;
 *  - audio bytes are only written when the caller explicitly asks (`saveAudio`).
 */
import type { AnalysisResult, Chart, Difficulty, RunResults, SongMeta } from '../core/types'
import { DIFFICULTIES } from '../core/types'
import { createId } from '../core/rng'
import { sortNotes } from '../chart/timing'
import { idbDelete, idbGet, idbGetAll, idbGetAllByIndex, idbPut, idbPutMany } from './db'
import type { StoredAnalysis, StoredAudio, StoredRun } from './db'

/* ----------------------------------------------------------------- songs */

export async function saveSong(meta: SongMeta): Promise<void> {
  await idbPut('songs', meta)
}

export async function getSong(songId: string): Promise<SongMeta | undefined> {
  return idbGet<SongMeta>('songs', songId)
}

/*
 * Rows are checked as they are read: one broken record (a half-written save, a field an older or
 * newer build named differently) must not take the whole library down. Bad rows are skipped, not
 * deleted, so nothing is lost if a later build can read them.
 */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const finite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value)
function validSong(row: unknown): row is SongMeta {
  return isRecord(row) && typeof row.id === 'string' && typeof row.title === 'string' && finite(row.duration) && isRecord(row.analysis) && finite(row.analysis.bpm)
}
function validChart(row: unknown): row is Chart {
  return isRecord(row) && typeof row.id === 'string' && Array.isArray(row.notes) && isRecord(row.timing) && Array.isArray(row.timing.bpms) && DIFFICULTIES.includes(row.difficulty as Difficulty)
}
function validRun(row: unknown): row is StoredRun {
  return isRecord(row) && typeof row.id === 'string' && typeof row.songId === 'string' && finite(row.score) && finite(row.createdAt) && DIFFICULTIES.includes(row.difficulty as Difficulty)
}
function keepValid<T>(rows: unknown[], valid: (row: unknown) => row is T, store: string): T[] {
  const kept = rows.filter(valid)
  if (kept.length < rows.length) console.warn(`[beatbreak] skipped ${rows.length - kept.length} unreadable ${store} record(s)`)
  return kept
}

export async function listSongs(): Promise<SongMeta[]> {
  const songs = keepValid(await idbGetAll<unknown>('songs'), validSong, 'song')
  return songs.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt || b.createdAt - a.createdAt)
}

export async function updateSong(songId: string, patch: Partial<SongMeta>): Promise<SongMeta | undefined> {
  const song = await getSong(songId)
  if (!song) return undefined
  const next: SongMeta = { ...song, ...patch, id: song.id }
  await idbPut('songs', next)
  return next
}

export async function deleteSong(songId: string): Promise<void> {
  const charts = await listCharts(songId)
  for (const chart of charts) await idbDelete('charts', chart.id)
  const runs = await listRuns(songId)
  for (const run of runs) await idbDelete('scores', run.id)
  await idbDelete('audio', songId)
  await idbDelete('analyses', songId)
  await idbDelete('songs', songId)
}

/* -------------------------------------------------------------- analyses */

/** Persist the full detector result so trim/regenerate survive a page reload. */
export async function saveAnalysis(songId: string, analysis: AnalysisResult): Promise<void> {
  const record: StoredAnalysis = { songId, analysis, savedAt: Date.now() }
  await idbPut('analyses', record)
}

export async function loadAnalysis(songId: string): Promise<AnalysisResult | null> {
  const record = await idbGet<StoredAnalysis>('analyses', songId)
  return record?.analysis ?? null
}

/* ---------------------------------------------------------------- charts */

export async function saveChart(chart: Chart): Promise<void> {
  const normalized: Chart = {
    ...chart,
    notes: sortNotes(chart.notes),
    updatedAt: Date.now(),
  }
  await idbPut('charts', normalized)
}

export async function saveCharts(charts: Chart[]): Promise<void> {
  const normalized = charts.map((chart) => ({ ...chart, notes: sortNotes(chart.notes), updatedAt: Date.now() }))
  await idbPutMany('charts', normalized)
}

export async function getChart(chartId: string): Promise<Chart | undefined> {
  return idbGet<Chart>('charts', chartId)
}

export async function listCharts(songId: string): Promise<Chart[]> {
  const charts = keepValid(await idbGetAllByIndex<unknown>('charts', 'songId', songId), validChart, 'chart')
  return charts.sort((a, b) => DIFFICULTIES.indexOf(a.difficulty) - DIFFICULTIES.indexOf(b.difficulty))
}

export async function deleteChart(chartId: string): Promise<void> {
  await idbDelete('charts', chartId)
}

/* ----------------------------------------------------------------- audio */

/** Store the original file bytes so this song can be played again without re-selecting a file. */
export async function saveAudio(songId: string, file: File): Promise<void> {
  const record: StoredAudio = {
    songId,
    blob: file,
    fileName: file.name,
    mimeType: file.type || 'audio/*',
    size: file.size,
    savedAt: Date.now(),
  }
  await idbPut('audio', record)
}

export async function loadAudio(songId: string): Promise<File | undefined> {
  const record = await idbGet<StoredAudio>('audio', songId)
  if (!record?.blob) return undefined
  return new File([record.blob], record.fileName || 'audio', { type: record.mimeType || 'audio/mpeg' })
}

export async function deleteAudio(songId: string): Promise<void> {
  await idbDelete('audio', songId)
}

/* ---------------------------------------------------------------- scores */

export interface SaveRunInput {
  songId: string
  songTitle: string
  artist: string
  results: RunResults
}

export async function saveRun(input: SaveRunInput): Promise<StoredRun> {
  const run: StoredRun = {
    ...input.results,
    id: createId('run'),
    songTitle: input.songTitle,
    artist: input.artist,
  }
  await idbPut('scores', run)
  return run
}

export async function listRuns(songId?: string): Promise<StoredRun[]> {
  const runs = keepValid(songId ? await idbGetAllByIndex<unknown>('scores', 'songId', songId) : await idbGetAll<unknown>('scores'), validRun, 'score')
  return runs.sort((a, b) => b.createdAt - a.createdAt)
}

/** Best cleared run of one chart; with `rules`, only runs on those rules (or old unstamped ones) count. */
export async function bestRunFor(songId: string, difficulty: Difficulty, mode: 'arrows' | 'circles' = 'arrows', rules?: string): Promise<StoredRun | undefined> {
  const runs = (await listRuns(songId)).filter(
    (run) =>
      run.difficulty === difficulty &&
      !run.failed &&
      (run.mode ?? 'arrows') === mode &&
      (rules === undefined || run.rules === undefined || run.rules === rules),
  )
  let best: StoredRun | undefined
  for (const run of runs) {
    if (!best || run.score > best.score) best = run
  }
  return best
}

export async function clearScores(songId?: string): Promise<void> {
  const runs = await listRuns(songId)
  for (const run of runs) await idbDelete('scores', run.id)
}

export async function deleteRun(runId: string): Promise<void> {
  await idbDelete('scores', runId)
}

/* ------------------------------------------------------------- utilities */

export interface StorageSummary {
  songs: number
  charts: number
  runs: number
  cachedAudio: number
}

export async function storageSummary(): Promise<StorageSummary> {
  const [songs, charts, runs, audio] = await Promise.all([
    idbGetAll<SongMeta>('songs'),
    idbGetAll<Chart>('charts'),
    idbGetAll<StoredRun>('scores'),
    idbGetAll<StoredAudio>('audio'),
  ])
  return { songs: songs.length, charts: charts.length, runs: runs.length, cachedAudio: audio.length }
}
