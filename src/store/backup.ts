/**
 * One file with the player's library: songs, charts (hand edits included), scores and settings.
 * Browsers can clear a site's storage (Safari after a week away, any browser short on space, a
 * new phone), so this is the way to keep it. The song files themselves are left out: they are
 * the player's own and far too big; after a restore each song asks for its file once.
 */
import type { Chart, SongMeta } from '../core/types'
import type { StoredRun } from './db'
import { idbGet, idbGetAll, idbPutMany } from './db'
import type { Settings } from './settings'

export const BACKUP_FORMAT = 'beatbreak-backup'
const BACKUP_VERSION = 1
const MAX_BACKUP_BYTES = 64 * 1024 * 1024
const MAX_ITEMS = 20000

export interface Backup {
  format: typeof BACKUP_FORMAT
  version: number
  savedAt: string
  songs: SongMeta[]
  charts: Chart[]
  scores: StoredRun[]
  settings?: Partial<Settings>
}

export async function buildBackup(settings: Settings): Promise<string> {
  const [songs, charts, scores] = await Promise.all([
    idbGetAll<SongMeta>('songs'),
    idbGetAll<Chart>('charts'),
    idbGetAll<StoredRun>('scores'),
  ])
  const backup: Backup = { format: BACKUP_FORMAT, version: BACKUP_VERSION, savedAt: new Date().toISOString(), songs, charts, scores, settings }
  return JSON.stringify(backup)
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length < 500
const num = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function validSong(value: unknown): value is SongMeta {
  return isObject(value) && str(value.id) && typeof value.title === 'string' && num(value.duration) && isObject(value.analysis) && num(value.analysis.bpm) && num(value.analysis.offset)
}

function validChart(value: unknown): value is Chart {
  return (
    isObject(value) &&
    str(value.id) &&
    str(value.songId) &&
    str(value.difficulty) &&
    Array.isArray(value.notes) &&
    value.notes.length <= MAX_ITEMS &&
    value.notes.every((note) => isObject(note) && num(note.time) && num(note.lane)) &&
    isObject(value.timing) &&
    Array.isArray(value.timing.bpms)
  )
}

function validRun(value: unknown): value is StoredRun {
  return isObject(value) && str(value.id) && str(value.songId) && num(value.score) && num(value.accuracy)
}

/** Read a backup file. Bad entries are skipped and counted; a file that is not a backup is refused. */
export function parseBackup(text: string): { backup: Backup; skipped: number } {
  if (text.length > MAX_BACKUP_BYTES) throw new Error('That file is too big to be a Beatbreak backup.')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('That file is not a Beatbreak backup.')
  }
  if (!isObject(raw) || raw.format !== BACKUP_FORMAT) throw new Error('That file is not a Beatbreak backup.')
  if (!num(raw.version) || raw.version > BACKUP_VERSION) throw new Error('This backup comes from a newer Beatbreak. Update the app first.')
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value.slice(0, MAX_ITEMS) : [])
  const songsIn = list(raw.songs)
  const chartsIn = list(raw.charts)
  const scoresIn = list(raw.scores)
  const songs = songsIn.filter(validSong)
  const ids = new Set(songs.map((song) => song.id))
  const charts = chartsIn.filter(validChart).filter((chart) => ids.has(chart.songId))
  const scores = scoresIn.filter(validRun).filter((run) => ids.has(run.songId))
  const skipped = songsIn.length - songs.length + (chartsIn.length - charts.length) + (scoresIn.length - scores.length)
  return {
    backup: {
      format: BACKUP_FORMAT,
      version: raw.version,
      savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
      songs,
      charts,
      scores,
      settings: isObject(raw.settings) ? (raw.settings as Partial<Settings>) : undefined,
    },
    skipped,
  }
}

/**
 * Put a backup into the library. Same ids are replaced by the backup's copy, everything else is
 * kept. A song whose file is not stored on this device is marked as needing it.
 */
export async function restoreBackup(backup: Backup): Promise<{ songs: number; charts: number; scores: number }> {
  const songs: SongMeta[] = []
  for (const song of backup.songs) {
    const audio = await idbGet('audio', song.id)
    songs.push({ ...song, audioCached: audio !== undefined })
  }
  await idbPutMany('songs', songs)
  await idbPutMany('charts', backup.charts)
  await idbPutMany('scores', backup.scores)
  return { songs: songs.length, charts: backup.charts.length, scores: backup.scores.length }
}
