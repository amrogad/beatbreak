/**
 * Runtime store for objects that must not go through React state:
 * decoded AudioBuffers and full analysis results (tens of megabytes each).
 *
 * React renders from lightweight metadata; the heavy objects live here and are fetched by id.
 * Bundles are dropped when a song is deleted so nothing is kept alive by accident.
 */
import type { AnalysisResult, Chart, SongMeta } from '../core/types'
import type { SongBundle } from '../store/library'

/** True while the chart editor holds edits that are not saved; the app shell asks before leaving. */
export const editorUnsaved = { current: false }

class RuntimeStore {
  private bundles = new Map<string, SongBundle>()

  put(bundle: SongBundle): void {
    this.bundles.set(bundle.meta.id, bundle)
  }

  get(songId: string): SongBundle | undefined {
    return this.bundles.get(songId)
  }

  getMeta(songId: string): SongMeta | undefined {
    return this.bundles.get(songId)?.meta
  }

  getCharts(songId: string): Chart[] | undefined {
    return this.bundles.get(songId)?.charts
  }

  getChart(songId: string, chartId: string): Chart | undefined {
    return this.bundles.get(songId)?.charts.find((chart) => chart.id === chartId)
  }

  getAnalysis(songId: string): AnalysisResult | undefined {
    return this.bundles.get(songId)?.analysis ?? undefined
  }

  setCharts(songId: string, charts: Chart[]): void {
    const bundle = this.bundles.get(songId)
    if (!bundle) return
    bundle.charts = charts
  }

  setMeta(songId: string, meta: SongMeta): void {
    const bundle = this.bundles.get(songId)
    if (!bundle) return
    bundle.meta = meta
  }

  evict(songId: string): void {
    this.bundles.delete(songId)
  }

  clear(): void {
    this.bundles.clear()
  }
}

export const runtime = new RuntimeStore()
