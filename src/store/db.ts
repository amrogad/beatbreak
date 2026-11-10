/**
 * IndexedDB access.
 *
 * Small promise wrapper around the callback API. It exists so the rest of the app can `await`
 * storage without pulling in a library, and so schema changes have exactly one place to land.
 *
 * What is stored where:
 *   songs   — SongMeta (title, peaks, analysis summary). Never audio bytes.
 *   charts  — Chart records (the playable data, generated and/or hand-edited), indexed by songId.
 *   audio   — optional decoded-source blobs, written **only** when the user asks to remember them.
 *   scores  — RunResults, indexed by songId.
 *   voices  — the singer's onsets, found once per song when a player follows the singer.
 */
import type { AnalysisResult, Chart, OnsetEvent, RunResults, SongMeta } from '../core/types'

export const DB_NAME = 'pulsegrid'
export const DB_VERSION = 5

export type StoreName = 'songs' | 'charts' | 'audio' | 'scores' | 'analyses' | 'voices'

export interface StoredAudio {
  songId: string
  /** Original file bytes. Re-decoded on load so the game always plays what the user selected. */
  blob: Blob
  fileName: string
  mimeType: string
  size: number
  savedAt: number
}

/** The full detector result. Kept out of `SongMeta` so listing the library stays lightweight. */
export interface StoredAnalysis {
  songId: string
  analysis: AnalysisResult
  savedAt: number
}

/** Where the singer sings in one song, from its isolated vocal track. */
export interface StoredVoice {
  songId: string
  /** Detector version: a newer one finds the singing again. */
  version: string
  onsets: OnsetEvent[]
  savedAt: number
}

export interface StoredRun extends RunResults {
  id: string
  songTitle: string
  artist: string
}

export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

let dbPromise: Promise<IDBDatabase> | null = null
/** Set once a newer build upgraded the database from another tab: this tab's code is now out of date. */
let outdated = false
/** How long an upgrade may wait on another tab before this call gives up (the open keeps going). */
const BLOCKED_GIVE_UP_MS = 8000

const RELOAD_MESSAGE = 'Beatbreak was updated in another tab. Reload this page to keep saving.'

/** Fired on window when this tab can no longer save because a newer build took over the database. */
export const DB_OUTDATED_EVENT = 'beatbreak:db-outdated'

function markOutdated(): void {
  if (outdated) return
  outdated = true
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(DB_OUTDATED_EVENT))
}

export function openDb(): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new Error('This browser has IndexedDB disabled (private browsing can do this).'))
  }
  if (outdated) return Promise.reject(new Error(RELOAD_MESSAGE))
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = (event) => {
      const db = request.result
      if (!db.objectStoreNames.contains('songs')) {
        const songs = db.createObjectStore('songs', { keyPath: 'id' })
        songs.createIndex('lastPlayedAt', 'lastPlayedAt')
      }
      if (!db.objectStoreNames.contains('charts')) {
        const charts = db.createObjectStore('charts', { keyPath: 'id' })
        charts.createIndex('songId', 'songId')
      }
      if (!db.objectStoreNames.contains('audio')) {
        db.createObjectStore('audio', { keyPath: 'songId' })
      }
      if (!db.objectStoreNames.contains('scores')) {
        const scores = db.createObjectStore('scores', { keyPath: 'id' })
        scores.createIndex('songId', 'songId')
      }
      if (!db.objectStoreNames.contains('analyses')) {
        db.createObjectStore('analyses', { keyPath: 'songId' })
      }
      if (!db.objectStoreNames.contains('voices')) {
        db.createObjectStore('voices', { keyPath: 'songId' })
      }
      // v4: the scoring scale dropped from 1,000 to 100 points per arrow. Existing runs are
      // divided once so old personal bests stay comparable instead of being ten times too high.
      if (event.oldVersion > 0 && event.oldVersion < 4) {
        const scores = request.transaction?.objectStore('scores')
        const cursorRequest = scores?.openCursor()
        if (cursorRequest) {
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result
            if (!cursor) return
            const run = cursor.value as StoredRun
            if (typeof run.score === 'number') {
              run.score = Math.round(run.score / 10)
              cursor.update(run)
            }
            cursor.continue()
          }
        }
      }
    }
    let blockedTimer: ReturnType<typeof setTimeout> | null = null
    request.onsuccess = () => {
      if (blockedTimer) clearTimeout(blockedTimer)
      const db = request.result
      db.onversionchange = () => {
        // A newer build in another tab is upgrading the schema: close so it can proceed. This tab
        // runs the old code and would open at the old version, so it stops saving and asks for a reload.
        db.close()
        dbPromise = null
        markOutdated()
      }
      // The browser can close the connection itself (site data cleared, storage evicted).
      db.onclose = () => {
        dbPromise = null
      }
      resolve(db)
    }
    request.onerror = () => {
      if (blockedTimer) clearTimeout(blockedTimer)
      dbPromise = null
      if (request.error?.name === 'VersionError') {
        markOutdated()
        reject(new Error(RELOAD_MESSAGE))
        return
      }
      reject(request.error ?? new Error('Could not open the local database.'))
    }
    request.onblocked = () => {
      // Another tab still holds the old version. Its onversionchange closes it, so this usually
      // clears at once; if it does not, give up on this call but let the open finish later.
      blockedTimer = setTimeout(() => {
        dbPromise = null
        reject(new Error('Another Beatbreak tab is holding the database open. Close it and retry.'))
      }, BLOCKED_GIVE_UP_MS)
    }
  })
  return dbPromise
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'))
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed.'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction was aborted.'))
  })
}

export async function idbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb()
  const tx = db.transaction(store, 'readonly')
  const result = await requestToPromise<T | undefined>(tx.objectStore(store).get(key))
  return result
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb()
  const tx = db.transaction(store, 'readonly')
  return requestToPromise<T[]>(tx.objectStore(store).getAll())
}

export async function idbGetAllByIndex<T>(store: StoreName, index: string, key: IDBValidKey): Promise<T[]> {
  const db = await openDb()
  const tx = db.transaction(store, 'readonly')
  return requestToPromise<T[]>(tx.objectStore(store).index(index).getAll(key))
}

export async function idbPut<T>(store: StoreName, value: T): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(store, 'readwrite')
  tx.objectStore(store).put(value)
  await txDone(tx)
}

export async function idbPutMany<T>(store: StoreName, values: T[]): Promise<void> {
  if (values.length === 0) return
  const db = await openDb()
  const tx = db.transaction(store, 'readwrite')
  const objectStore = tx.objectStore(store)
  for (const value of values) objectStore.put(value)
  await txDone(tx)
}

export async function idbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(store, 'readwrite')
  tx.objectStore(store).delete(key)
  await txDone(tx)
}

export async function idbClear(store: StoreName): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(store, 'readwrite')
  tx.objectStore(store).clear()
  await txDone(tx)
}

/** Wipe every Beatbreak store (settings live in localStorage and are cleared separately). */
export async function wipeDatabase(): Promise<void> {
  for (const store of ['songs', 'charts', 'audio', 'scores', 'analyses', 'voices'] as StoreName[]) {
    await idbClear(store)
  }
}

export type { Chart, RunResults, SongMeta }
