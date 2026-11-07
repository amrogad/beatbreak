/** Small formatting helpers shared by the screens. */

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00'
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatClock(seconds: number): string {
  const sign = seconds < 0 ? '-' : ''
  const abs = Math.abs(seconds)
  const m = Math.floor(abs / 60)
  const s = abs - m * 60
  return `${sign}${m}:${s.toFixed(2).padStart(5, '0')}`
}

export const formatSync = (ms: number): string => (ms === 0 ? '0 ms' : `${Math.abs(ms)} ms ${ms < 0 ? 'earlier' : 'later'}`)

export const SYNC_HINT =
  'Lines the arrows up with what you hear; arrow speed stays the same. If the beat comes before the arrows reach the targets, move it earlier. It depends on your speakers or headphones, so it counts for every song.'

/** Engine and storage failures in words a player can act on; our own messages pass through. */
export function friendlyError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught)
  if (/allocation failed|invalid typed array length|out of memory|array buffer|maximum call stack/i.test(message)) {
    return 'This song needs more memory than this device can give the browser. Close other tabs, or try a shorter version of the song.'
  }
  if (/quota|QuotaExceeded/i.test(message)) return 'The browser has run out of space for Beatbreak. Delete a few songs, or free space in Settings > Storage.'
  if (/worker stopped responding|analysis worker crashed/i.test(message)) {
    return 'Reading the song took too long and was stopped. Try again; if it keeps happening, try a shorter version of the song.'
  }
  return message
}
