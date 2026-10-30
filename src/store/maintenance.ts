/**
 * Storage maintenance: the operations behind the Settings → Storage panel.
 *
 * Kept separate from `repository.ts` so the "dangerous" bulk operations have one obvious home and
 * always keep the database and the in-memory runtime store consistent.
 */
import { idbClear, idbGetAll, idbPutMany, wipeDatabase } from './db'
import type { SongMeta } from '../core/types'
import { runtime } from '../app/runtime'
import { listRuns, storageSummary } from './repository'
import type { StorageSummary } from './repository'
import { idbDelete } from './db'

export type { StorageSummary }

export { storageSummary }

/** Delete every stored run. */
export async function clearScores(): Promise<void> {
  const runs = await listRuns()
  for (const run of runs) await idbDelete('scores', run.id)
}

/**
 * Drop all cached audio files and clear the `audioCached` flag on every song, so the library
 * never claims to have audio it no longer has.
 */
export async function idbAudioClearAndFlag(): Promise<void> {
  await idbClear('audio')
  const songs = await idbGetAll<SongMeta>('songs')
  const updated = songs.map((song) => (song.audioCached ? { ...song, audioCached: false } : song))
  await idbPutMany('songs', updated)
  for (const song of updated) {
    const bundle = runtime.get(song.id)
    if (bundle) bundle.meta = song
  }
}

/** Delete songs, charts, cached audio, scores, and forget the persisted settings. */
export async function wipeEverything(): Promise<void> {
  await wipeDatabase()
  runtime.clear()
  try {
    localStorage.removeItem('pulsegrid:settings:v1')
  } catch {
    /* storage unavailable */
  }
}
