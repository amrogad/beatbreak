/** Best-score aggregation for the library and setup screens. */
import type { Difficulty, RunResults } from '../../core/types'
import { listRuns } from '../../store/repository'
import type { Settings } from '../../store/settings'

type RulesSettings = Pick<Settings, 'windowPreset' | 'customWindows' | 'timing' | 'holdMode' | 'longArrows' | 'noteShape'>

/**
 * A short stamp of the settings that make a score easier or harder to get: the hit windows, phone
 * timing, how long arrows are judged, long arrows off (holds become taps) and rectangles (a tap
 * counts while the rectangle overlaps its target). A best on lenient rules must not block a
 * strict one, so bests are only compared between runs with the same stamp.
 */
export function runRulesKey(settings: RulesSettings, mode: 'arrows' | 'circles'): string {
  const w = settings.customWindows
  const windows = settings.windowPreset === 'custom' ? `custom ${w.marvelous}/${w.perfect}/${w.great}/${w.good}` : settings.windowPreset
  // Circles always use the phone window scale and have no long-arrow or rectangle settings.
  if (mode === 'circles') return `circles ${windows}`
  return [
    windows,
    settings.timing === 'phone' && settings.windowPreset !== 'custom' ? 'phone' : 'pc',
    settings.longArrows ? `long ${settings.holdMode}` : 'no long',
    settings.noteShape === 'tile' ? 'rect' : 'arrow',
  ].join(' | ')
}

/** Old runs carry no stamp and count under any rules, so nobody loses a best they already had. */
export function sameRules(run: Pick<RunResults, 'rules'>, rules: string): boolean {
  return run.rules === undefined || run.rules === rules
}

export interface BestScoreEntry {
  score: number
  accuracy: number
  grade: string
  failed: boolean
  createdAt: number
}

export type BestScores = Record<string, Partial<Record<Difficulty, BestScoreEntry>>>

/** One pass over the score store: best finished score per song and difficulty, on the given rules. */
export async function loadBestScores(mode: 'arrows' | 'circles', rules: string): Promise<BestScores> {
  const runs = await listRuns()
  const best: BestScores = {}
  for (const run of runs) {
    if ((run.mode ?? 'arrows') !== mode || !sameRules(run, rules)) continue
    // Only finished songs count: a failed or empty run is not a high score.
    if (run.failed || run.score <= 0) continue
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
