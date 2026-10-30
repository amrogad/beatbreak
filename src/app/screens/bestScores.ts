/** Best-score aggregation for the library and setup screens. */
import type { Difficulty } from '../../core/types'
import { listRuns } from '../../store/repository'

export interface BestScoreEntry {
  score: number
  accuracy: number
  grade: string
  failed: boolean
  createdAt: number
}

export type BestScores = Record<string, Partial<Record<Difficulty, BestScoreEntry>>>

/** One pass over the score store: best (non-failed) score per song and difficulty. */
export async function loadBestScores(): Promise<BestScores> {
  const runs = await listRuns()
  const best: BestScores = {}
  for (const run of runs) {
    const perSong = (best[run.songId] ??= {})
    const current = perSong[run.difficulty]
    // A cleared run always beats a failed one; otherwise the higher score wins.
    const better =
      !current || (current.failed !== run.failed ? current.failed && !run.failed : run.score > current.score)
    if (better) {
      perSong[run.difficulty] = {
        score: run.score,
        accuracy: run.accuracy,
        grade: run.grade,
        failed: run.failed,
        createdAt: run.createdAt,
      }
    }
  }
  return best
}
