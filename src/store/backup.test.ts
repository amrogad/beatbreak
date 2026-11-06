import { describe, expect, it } from 'vitest'
import { BACKUP_FORMAT, parseBackup } from './backup'

const song = (id: string) => ({ id, title: 'Song', duration: 180, analysis: { bpm: 120, offset: 0.1 } })
const chart = (id: string, songId: string) => ({ id, songId, difficulty: 'easy', notes: [{ time: 1, lane: 0 }], timing: { offset: 0, bpms: [{ beat: 0, bpm: 120 }] } })
const run = (id: string, songId: string) => ({ id, songId, score: 100, accuracy: 0.9 })

describe('backup files', () => {
  it('reads a backup and keeps its songs, charts, scores and settings', () => {
    const text = JSON.stringify({ format: BACKUP_FORMAT, version: 1, songs: [song('a')], charts: [chart('c1', 'a')], scores: [run('r1', 'a')], settings: { volume: 0.5 } })
    const { backup, skipped } = parseBackup(text)
    expect(skipped).toBe(0)
    expect(backup.songs.map((s) => s.id)).toEqual(['a'])
    expect(backup.charts).toHaveLength(1)
    expect(backup.scores).toHaveLength(1)
    expect(backup.settings).toEqual({ volume: 0.5 })
  })

  it('refuses files that are not backups, or from a newer version', () => {
    expect(() => parseBackup('not json')).toThrow(/not a Beatbreak backup/)
    expect(() => parseBackup(JSON.stringify({ format: 'other', version: 1 }))).toThrow(/not a Beatbreak backup/)
    expect(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 99 }))).toThrow(/newer/)
  })

  it('skips broken entries and charts or scores of songs that are not in the file', () => {
    const text = JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      songs: [song('a'), { id: 'bad' }, null],
      charts: [chart('c1', 'a'), chart('c2', 'missing'), { id: 'c3' }],
      scores: [run('r1', 'a'), run('r2', 'missing')],
    })
    const { backup, skipped } = parseBackup(text)
    expect(backup.songs).toHaveLength(1)
    expect(backup.charts.map((c) => c.id)).toEqual(['c1'])
    expect(backup.scores.map((r) => r.id)).toEqual(['r1'])
    expect(skipped).toBe(5)
  })
})
