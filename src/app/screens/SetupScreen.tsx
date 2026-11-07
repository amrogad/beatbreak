/**
 * Song setup, deliberately small: pick a difficulty, press Play.
 *
 * The technical controls that used to live here (BPM/offset correction, waveform editing, trim
 * handles, confidence numbers) were removed. A player should not need to understand onset
 * detection to start a song. Auto-trim is applied once at import and can be switched off with
 * "Whole song"; a new arrow variation is an explicit opt-in.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Chart, Difficulty } from '../../core/types'
import { DIFFICULTIES, DIFFICULTY_COLOR, DIFFICULTY_LABEL } from '../../core/types'
import type { SongBundle } from '../../store/library'
import {
  importSongFromFile,
  loadSongBundle,
  beatOf,
  regenerateCharts,
  setSongTrim,
  titleFromFileName,
  trimDraftFor,
} from '../../store/library'
import { runtime } from '../runtime'
import { saveAnalysis, saveAudio, updateSong } from '../../store/repository'
import type { Settings } from '../../store/settings'
import { decodeAudioFile } from '../../audio/engine'
import { downmixMono } from '../../audio/analyze'
import { removeFromTrim, removedParts, snapTrimRange, type TrimPlan, type TrimRange } from '../../audio/trim'
import { DEMO_FILE_NAME } from '../../audio/synth'
import { planForMeta } from '../../core/edit'
import { rateSong } from '../../chart/generate'
import { circleRhythm, placeCircles } from '../../chart/circles'
import { AnalysisClient, AnalysisCancelledError } from '../../workers/analysisClient'
import { BackButton, Button, Choice, Modal, Panel, ProgressBar, Slider, Spinner } from '../components'
import { TrimEditor } from '../TrimEditor'
import { SYNC_HINT, formatDuration, formatPercent, formatSync, friendlyError } from '../format'
import type { BestScores } from './bestScores'

type Phase = 'idle' | 'importing' | 'ready' | 'error'

function ScissorsIcon(): React.JSX.Element {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M8.2 8.2 20 20M8.2 15.8 20 4" />
    </svg>
  )
}

export interface SetupScreenProps {
  file: File | null
  songId: string | null
  settings: Settings
  bestScores: BestScores
  onUpdateSettings: (patch: Partial<Settings>) => void
  onBack: () => void
  onRetry: () => void
  onPlay: (request: { songId: string; chartId: string; difficulty: Difficulty; autoPlay: boolean }) => void
  onOpenEditor: (songId: string, chartId: string) => void
  onBundleReady: (bundle: SongBundle) => void
  onToast: (message: string, tone?: 'info' | 'error' | 'success') => void
}

const DIFFICULTY_COPY: Record<Difficulty, string> = {
  easy: 'One arrow at a time, on the beat. A steady first run.',
  normal: 'A steady single-arrow stream, still easy to read.',
  hard: 'Faster runs, with occasional two-arrow jumps.',
  expert: 'The full chart, including rare three- and four-arrow accents.',
}

const CIRCLE_COPY: Record<Difficulty, string> = {
  easy: 'Slow rings, evenly spaced, on the beat.',
  normal: 'A steady flow with sliders, no jumps.',
  hard: 'Quicker runs and jumps on the big beats.',
  expert: 'Fast rings, wide jumps and short bursts.',
}

const DIFFICULTY_ORDER: Difficulty[] = [...DIFFICULTIES]

export function SetupScreen({
  file,
  songId,
  settings,
  bestScores,
  onUpdateSettings,
  onBack,
  onRetry,
  onPlay,
  onOpenEditor,
  onBundleReady,
  onToast,
}: SetupScreenProps): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<{ stage: string; fraction: number }>({ stage: 'Preparing', fraction: 0 })
  const [error, setError] = useState<string | null>(null)
  const [bundle, setBundle] = useState<SongBundle | null>(null)
  const [difficulty, setDifficulty] = useState<Difficulty>('normal')
  const [title, setTitle] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [askRegenerate, setAskRegenerate] = useState(false)
  const [rangeBusy, setRangeBusy] = useState(false)
  const [selection, setSelection] = useState<TrimRange | null>(null)
  const [trimming, setTrimming] = useState(false)
  const [trimHistory, setTrimHistory] = useState<TrimPlan[]>([])
  const [variationBusy, setVariationBusy] = useState(false)
  const [beatBusy, setBeatBusy] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const analysisClientRef = useRef<AnalysisClient | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const chosenForRef = useRef<string | null>(null)
  // App passes a fresh inline callback on every render. Keeping it in a ref keeps the import
  // effect stable; otherwise `refreshLibrary()` on completion re-rendered App and restarted the
  // import, which looked like an endless "Reading the song" loop.
  const bundleReadyRef = useRef(onBundleReady)
  useEffect(() => {
    bundleReadyRef.current = onBundleReady
  }, [onBundleReady])

  const charts = bundle?.charts ?? []
  const circleMode = settings.playMode === 'circles'
  const things = circleMode ? 'circles' : 'arrows'
  // Circle counts come from the real placement: chords become one circle, some pairs one slider.
  const circleCounts = useMemo(() => {
    if (!circleMode) return null
    const counts = new Map<string, { circles: number; sliders: number }>()
    for (const chart of bundle?.charts ?? []) {
      const objects = placeCircles(chart, circleRhythm(bundle?.charts ?? [], chart)).objects
      counts.set(chart.id, { circles: objects.length, sliders: objects.filter((o) => o.kind === 'slider').length })
    }
    return counts
  }, [circleMode, bundle?.charts])
  const duration = bundle?.meta.duration ?? 0
  const analysis = bundle?.analysis ?? null

  const adopt = useCallback((next: SongBundle) => {
    runtime.put(next)
    setBundle(next)
    setTitle(next.meta.title)
    setPhase('ready')
    bundleReadyRef.current(next)
  }, [])

  /* --------------------------------------------------------------- importing */

  useEffect(() => {
    if (!file) return
    let cancelled = false
    const controller = new AbortController()
    abortRef.current = controller
    const client = new AnalysisClient()
    analysisClientRef.current = client
    setPhase('importing')
    setError(null)
    setProgress({ stage: 'Reading the song', fraction: 0 })
    importSongFromFile(file, {
      analysisClient: client,
      signal: controller.signal,
      onProgress: (value) => {
        if (!cancelled) setProgress(value)
      },
    })
      .then((result) => {
        if (cancelled) return
        adopt(result)
        const meta = result.meta
        const skipped = (meta.trimStart ?? 0) + (meta.duration - (meta.trimEnd ?? meta.duration))
        if (!meta.trimManual && skipped >= 0.5 && Date.now() - meta.createdAt < 60_000) {
          onToast(`Skipped ${Math.round(skipped)} s of silence at the edges. Trim, then Restore whole song, plays all of it.`, 'info')
        }
        if (result.audioNotSaved) onToast('Your browser is not keeping files for Beatbreak right now (storage full or blocked), so pick this song again next time.', 'info')
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        if (caught instanceof AnalysisCancelledError || (caught instanceof DOMException && caught.name === 'AbortError')) {
          onBack()
          return
        }
        setError(friendlyError(caught))
        setPhase('error')
      })
      .finally(() => {
        client.dispose()
        analysisClientRef.current = null
      })
    return () => {
      cancelled = true
      controller.abort()
      client.cancel()
      client.dispose()
      analysisClientRef.current = null
    }
  }, [file, adopt, onBack])

  /* ----------------------------------------------------------- open from library */

  useEffect(() => {
    if (file || !songId) return
    const existing = runtime.get(songId)
    if (existing) {
      setBundle(existing)
      setTitle(existing.meta.title)
      setPhase('ready')
      return
    }
    let cancelled = false
    setPhase('idle')
    loadSongBundle(songId)
      .then((loaded) => {
        if (cancelled) return
        if (!loaded) {
          setError('This song is no longer in the library.')
          setPhase('error')
          return
        }
        runtime.put(loaded)
        setBundle(loaded)
        setTitle(loaded.meta.title)
        setPhase('ready')
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setError(friendlyError(caught))
        setPhase('error')
      })
    return () => {
      cancelled = true
    }
  }, [file, songId])

  /* ------------------------------------------------------------- difficulty */

  const songRating = useMemo(() => (charts.length > 0 ? rateSong(charts) : null), [charts])
  const recommended = songRating?.difficulty ?? null
  const selectedChart = charts.find((chart) => chart.difficulty === difficulty) ?? charts[0] ?? null
  const bundleMeta = bundle?.meta

  useEffect(() => {
    if (!bundleMeta) return
    if (chosenForRef.current === bundleMeta.id) return
    chosenForRef.current = bundleMeta.id
    // The song's own last pick wins; otherwise the default from Settings, or the recommendation.
    // The recommendation rates the song, not the player: someone with no cleared run yet starts
    // no higher than Normal.
    const newPlayer = Object.keys(bestScores).length === 0
    const capped = newPlayer && (recommended === 'hard' || recommended === 'expert') ? 'normal' : recommended
    const fallback = settings.defaultDifficulty === 'auto' ? capped : settings.defaultDifficulty
    setDifficulty(bundleMeta.preferredDifficulty ?? fallback ?? 'normal')
  }, [bundleMeta, recommended, settings.defaultDifficulty, bestScores])

  const chooseDifficulty = useCallback(
    (next: Difficulty) => {
      setDifficulty(next)
      if (!bundle) return
      void updateSong(bundle.meta.id, { preferredDifficulty: next }).then((updated) => {
        if (updated) setBundle((current) => (current ? { ...current, meta: updated } : current))
      })
    },
    [bundle],
  )

  // The slider moves at once; the song is saved when it settles.
  const speedSaveRef = useRef<number | undefined>(undefined)
  const chooseSpeed = useCallback(
    (next: number | undefined) => {
      if (!bundle) return
      const songId = bundle.meta.id
      setBundle((current) => (current ? { ...current, meta: { ...current.meta, scrollSpeed: next } } : current))
      window.clearTimeout(speedSaveRef.current)
      speedSaveRef.current = window.setTimeout(() => void updateSong(songId, { scrollSpeed: next }), 300)
    },
    [bundle],
  )
  useEffect(() => () => window.clearTimeout(speedSaveRef.current), [])

  const saveTitle = useCallback(async () => {
    setRenaming(false)
    if (!bundle) return
    const next = title.trim()
    if (!next || next === bundle.meta.title) {
      setTitle(bundle.meta.title)
      return
    }
    const updated = await updateSong(bundle.meta.id, { title: next })
    if (!updated) {
      onToast('Could not save: the song is no longer in the library.', 'error')
      return
    }
    setBundle((current) => (current ? { ...current, meta: updated } : current))
    setTitle(updated.title)
  }, [bundle, onToast, title])

  const applyTrim = useCallback(
    async (trim: TrimPlan, done: string) => {
      if (!bundle || rangeBusy) return
      if (!analysis) {
        onToast('Re-attach the audio file to change the song range.', 'error')
        return
      }
      setRangeBusy(true)
      try {
        const updated = await setSongTrim(bundle.meta.id, trim)
        if (!updated) throw new Error('The song is no longer in the library.')
        const regenerated = await regenerateCharts({
          analysis,
          duration: updated.duration,
          songId: updated.id,
          title: updated.title,
          bpm: beatOf(updated).bpm,
          offset: beatOf(updated).offset,
          edit: planForMeta(updated),
          // The player's "New arrows" pick survives a trim.
          salt: updated.chartVariant ?? 0,
          existing: bundle.charts,
        })
        adopt({ ...bundle, meta: updated, charts: regenerated })
        setSelection(null)
        onToast(done, 'success')
      } catch (caught) {
        onToast(caught instanceof Error ? caught.message : String(caught), 'error')
      } finally {
        setRangeBusy(false)
      }
    },
    [adopt, analysis, bundle, onToast, rangeBusy],
  )

  /** The player's beat fix: half or double tempo, or the beat moved by half a beat. Rebuilds unedited charts. */
  /** Back to the detected beat, for a song whose beat the player changed with the old beat buttons. */
  const resetBeat = useCallback(
    async () => {
      if (!bundle || beatBusy) return
      if (!analysis) {
        onToast('Re-attach the audio file to change the beat.', 'error')
        return
      }
      setBeatBusy(true)
      try {
        const updated = await updateSong(bundle.meta.id, { beatFix: undefined })
        if (!updated) throw new Error('The song is no longer in the library.')
        const beat = beatOf(updated)
        const regenerated = await regenerateCharts({
          analysis,
          duration: updated.duration,
          songId: updated.id,
          title: updated.title,
          bpm: beat.bpm,
          offset: beat.offset,
          edit: planForMeta(updated),
          salt: updated.chartVariant ?? 0,
          existing: bundle.charts,
        })
        adopt({ ...bundle, meta: updated, charts: regenerated })
        const kept = bundle.charts.some((chart) => chart.edited) ? ' Charts you edited by hand were kept.' : ''
        onToast(`Back to the beat the app found. ${things === 'circles' ? 'Circles' : 'Arrows'} rebuilt.${kept}`, 'success')
      } catch (caught) {
        onToast(caught instanceof Error ? caught.message : String(caught), 'error')
      } finally {
        setBeatBusy(false)
      }
    },
    [adopt, analysis, beatBusy, bundle, onToast, things],
  )

  const newVariation = useCallback(async (replaceEdited: boolean) => {
    setAskRegenerate(false)
    if (!bundle || variationBusy) return
    if (!analysis) {
      onToast(`Re-attach the audio file to build new ${things}.`, 'error')
      return
    }
    setVariationBusy(true)
    try {
      const salt = (bundle.meta.chartVariant ?? 0) + 1
      const updated = await updateSong(bundle.meta.id, { chartVariant: salt })
      if (!updated) throw new Error('The song is no longer in the library.')
      const regenerated = await regenerateCharts({
        analysis,
        duration: updated.duration,
        songId: updated.id,
        title: updated.title,
        bpm: beatOf(updated).bpm,
        offset: beatOf(updated).offset,
        edit: planForMeta(updated),
        salt,
        existing: bundle.charts,
        replaceEdited,
      })
      adopt({ ...bundle, meta: updated, charts: regenerated })
      onToast(
        !replaceEdited && bundle.charts.some((chart) => chart.edited)
          ? `New ${things} built. Charts you edited by hand were kept.`
          : `New ${things} built.`,
        'success',
      )
    } catch (caught) {
      onToast(caught instanceof Error ? caught.message : String(caught), 'error')
    } finally {
      setVariationBusy(false)
    }
  }, [adopt, analysis, bundle, onToast, variationBusy])

  /* ------------------------------------------------------------------- audio */

  const attachFile = useCallback(
    async (chosen: File) => {
      if (!bundle) return
      setAttaching(true)
      try {
        const buffer = await decodeAudioFile(chosen)
        // The charts were made for this song: a file of a different length is a different song.
        if (Math.abs(buffer.duration - bundle.meta.duration) > 1.5) {
          onToast(
            `That file is ${formatDuration(buffer.duration)} long, but this song is ${formatDuration(bundle.meta.duration)}. Pick the same file, or add it as a new song from Home.`,
            'error',
          )
          return
        }
        let nextAnalysis = bundle.analysis
        if (!nextAnalysis) {
          const client = new AnalysisClient()
          try {
            const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
            nextAnalysis = await client.analyze(downmixMono(channels, buffer.length), buffer.sampleRate, {
              owned: buffer.numberOfChannels > 1,
            })
          } finally {
            client.dispose()
          }
        }
        if (nextAnalysis) await saveAnalysis(bundle.meta.id, nextAnalysis)
        let nextMeta = bundle.meta
        await saveAudio(bundle.meta.id, chosen)
        nextMeta = (await updateSong(bundle.meta.id, { audioCached: true })) ?? nextMeta
        const next: SongBundle = { ...bundle, meta: nextMeta, buffer, analysis: nextAnalysis }
        adopt(next)
        onToast('Audio attached. The song is ready to play.', 'success')
      } catch (caught) {
        onToast(caught instanceof Error ? caught.message : String(caught), 'error')
      } finally {
        setAttaching(false)
      }
    },
    [adopt, bundle, onToast],
  )

  /* ------------------------------------------------------------------- play */

  const startRun = useCallback(() => {
    if (!bundle?.buffer) {
      onToast('Attach the audio file first.', 'error')
      return
    }
    const chart = bundle.charts.find((item) => item.difficulty === difficulty) ?? bundle.charts[0]
    if (!chart) {
      onToast('No chart for this difficulty.', 'error')
      return
    }
    if (chart.notes.length === 0) {
      onToast('This chart has no arrows. Add some in the editor or build new arrows.', 'error')
      return
    }
    onPlay({ songId: bundle.meta.id, chartId: chart.id, difficulty: chart.difficulty, autoPlay: settings.autoPlay })
  }, [bundle, difficulty, onPlay, onToast, settings.autoPlay])

  /* ------------------------------------------------------------------ render */

  if (phase === 'error') {
    return (
      <div className="page narrow">
        <Panel title="Could not open the song">
          <p className="muted">{error}</p>
          <div className="row gap-8 mt-16">
            <Button variant="primary" onClick={onBack}>
              Back
            </Button>
            {file && <Button onClick={onRetry}>Try again</Button>}
          </div>
        </Panel>
      </div>
    )
  }

  if (phase === 'importing' || !bundle) {
    return (
      <div className="page narrow">
        <Panel title={file ? (file.name === DEMO_FILE_NAME ? 'Generating audio track' : `Building charts for ${titleFromFileName(file.name)}`) : 'Loading song'}>
          <div className="row-between gap-16">
            <Spinner label={progress.stage} />
            <span className="mono small">{Math.round(progress.fraction * 100)}%</span>
          </div>
          <div className="mt-12">
            <ProgressBar fraction={progress.fraction} />
          </div>
          <div className="mt-16">
            <Button variant="ghost" onClick={onBack}>
              Cancel
            </Button>
          </div>
        </Panel>
      </div>
    )
  }

  const meta = bundle.meta
  const scores = bestScores[meta.id]
  const trim = trimDraftFor(meta)
  const wholeSong = trim.cuts.length === 0 && trim.start <= 0.01 && trim.end >= meta.duration - 0.01
  const playLength = planForMeta(meta).duration
  const rangeLabel = wholeSong
    ? `Whole song - ${formatDuration(meta.duration)}`
    : `${formatDuration(playLength)} of ${formatDuration(meta.duration)} plays`
  const chooseSelection = (range: TrimRange | null): void => {
    setSelection(range && (snapTrimRange(trim, range, meta.analysis) ?? range))
  }
  const cutSelection = (): void => {
    if (!selection) {
      onToast('Highlight a part of the song first.', 'info')
      return
    }
    const next = removeFromTrim(trim, selection)
    if (!next) {
      onToast('That would leave too little of the song to play.', 'error')
      return
    }
    setTrimHistory((history) => [...history, trim])
    void applyTrim(next, `Part removed. ${circleMode ? 'Circles' : 'Arrows'} rebuilt.`)
  }
  const undoTrim = (): void => {
    const previous = trimHistory[trimHistory.length - 1]
    if (!previous) return
    setTrimHistory((history) => history.slice(0, -1))
    void applyTrim(previous, `Undone. ${circleMode ? 'Circles' : 'Arrows'} rebuilt.`)
  }
  const editedCharts = charts.filter((chart) => chart.edited)
  const regenerate = (): void => {
    if (editedCharts.length > 0) setAskRegenerate(true)
    else void newVariation(false)
  }
  const restoreWholeSong = (): void => {
    setTrimHistory((history) => [...history, trim])
    void applyTrim({ start: 0, end: meta.duration, cuts: [] }, `The whole song plays again. ${circleMode ? 'Circles' : 'Arrows'} rebuilt.`)
  }

  return (
    <div className="page narrow">
      <div className="row-between wrap gap-12">
        <div>
          <div className="title-row">
            <BackButton onClick={onBack} />
            {renaming ? (
              <input
                className="title-input"
                type="text"
                value={title}
                aria-label="Song title"
                autoFocus
                onFocus={(event) => event.target.select()}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => void saveTitle()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                  if (event.key === 'Escape') {
                    setTitle(meta.title)
                    setRenaming(false)
                  }
                }}
              />
            ) : (
              <h1>
                <button type="button" className="title-button" onClick={() => setRenaming(true)} title="Tap to rename">
                  {meta.title}
                </button>
              </h1>
            )}
          </div>
          {meta.artist && <p className="muted small">{meta.artist}</p>}
        </div>
      </div>

      {!bundle.buffer && (
        <Panel>
          <div className="row-between wrap gap-16">
            <div>
              <h2>Attach the song again</h2>
              <p className="muted small mt-4">
                The charts are saved, but the audio file is missing. Choose the same file to play.
              </p>
            </div>
            <Button
              variant="primary"
              onClick={() => fileInputRef.current?.click()}
              disabled={attaching}
            >
              {attaching ? 'Reading…' : 'Choose audio file'}
            </Button>
          </div>
        </Panel>
      )}

      <Panel title="Choose a difficulty">
        <Choice
          label="Mode"
          value={settings.playMode}
          options={[
            { value: 'arrows', label: 'Arrows' },
            { value: 'circles', label: 'Circles (Beta)' },
          ]}
          onChange={(value) => onUpdateSettings({ playMode: value })}
        />
        <div className="difficulty-grid mt-12" role="radiogroup" aria-label="Difficulty">
          {DIFFICULTY_ORDER.map((item) => {
            const chart = charts.find((candidate) => candidate.difficulty === item)
            const best = scores?.[item]
            const holds = chart?.notes.filter((note) => note.kind === 'hold').length ?? 0
            const selected = item === difficulty
            return (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`difficulty-card${selected ? ' is-selected' : ''}`}
                style={{ '--difficulty': DIFFICULTY_COLOR[item] } as React.CSSProperties}
                onClick={() => chooseDifficulty(item)}
              >
                <span className="difficulty-top">
                  <span className="difficulty-name">{DIFFICULTY_LABEL[item]}</span>
                  {recommended === item && <span className="badge badge-recommended">Recommended</span>}
                </span>
                <span className="difficulty-copy">{(circleMode ? CIRCLE_COPY : DIFFICULTY_COPY)[item]}</span>
                <span className="difficulty-meta">
                  {!chart
                    ? 'Not available'
                    : circleCounts
                      ? `${(circleCounts.get(chart.id)?.circles ?? 0).toLocaleString('en-US')} circles - ${circleCounts.get(chart.id)?.sliders ?? 0} sliders`
                      : `${chart.stats.noteCount.toLocaleString('en-US')} arrows${holds > 0 ? ` - ${holds} holds` : ''}`}
                </span>
                <span className="difficulty-best">
                  {best
                    ? `Best ${formatPercent(best.accuracy)}${best.grade ? ` - ${best.grade}` : ''}`
                    : 'No score yet'}
                </span>
              </button>
            )
          })}
        </div>

        <div className="setup-play mt-24">
          <div className="row gap-8 wrap">
            <Button
              size="lg"
              variant="ghost"
              disabled={!selectedChart}
              onClick={() => selectedChart && onOpenEditor(meta.id, selectedChart.id)}
            >
              {circleMode ? 'Edit rhythm' : 'Edit arrows'}
            </Button>
            <Button
              size="lg"
              variant="primary"
              onClick={startRun}
              disabled={!bundle.buffer || !selectedChart}
              title={bundle.buffer ? 'Start the run' : 'Attach the audio file to play'}
            >
              ▶ Play {DIFFICULTY_LABEL[difficulty]}
            </Button>
          </div>
        </div>
        {!bundle.buffer && (
          <p className="muted tiny mt-8">Attach the audio file above to enable Play.</p>
        )}
      </Panel>

      <Panel title="Song options">
        <div className="row-between wrap gap-12">
          <div>
            <strong>Song range</strong>
            <p className="muted small">{rangeLabel}</p>
          </div>
          <div className="row gap-8 wrap">
            <Button
              size="sm"
              variant="ghost"
              disabled={variationBusy || rangeBusy || !analysis}
              onClick={regenerate}
              title={analysis ? 'Build all four charts again with a new pattern' : 'Re-attach the audio first'}
            >
              {variationBusy ? 'Building…' : circleMode ? 'Regenerate circles' : 'Regenerate arrows'}
            </Button>
            <Button
              size="sm"
              variant={trimming ? 'ghost' : 'primary'}
              disabled={!analysis}
              onClick={() => {
                setTrimming((current) => !current)
                setSelection(null)
              }}
              title={analysis ? undefined : 'Re-attach the audio to change this'}
            >
              {trimming ? 'Done' : 'Trim'}
            </Button>
          </div>
        </div>
        {meta.beatFix && (
          <div className="row-between wrap gap-12 mt-16">
            <p className="muted small">You changed this song's beat earlier.</p>
            <Button size="sm" variant="ghost" disabled={beatBusy || !analysis} onClick={() => void resetBeat()}>
              Undo beat change
            </Button>
          </div>
        )}
        {trimming && (
          <div className="trim-panel mt-12">
            <TrimEditor
              peaks={meta.peaks}
              duration={meta.duration}
              removed={removedParts(trim, meta.duration)}
              selection={selection}
              disabled={rangeBusy}
              onSelect={chooseSelection}
            />
            <p className="muted tiny">Drag across the song to highlight a part, then press the scissors to cut it out.</p>
            <div className="trim-tools">
              <Button variant="primary" disabled={rangeBusy} onClick={cutSelection} title="Cut the highlighted part">
                <ScissorsIcon />
              </Button>
              <div className="row gap-8 wrap">
                <Button size="sm" variant="ghost" disabled={trimHistory.length === 0 || rangeBusy} onClick={undoTrim}>
                  Undo
                </Button>
                <Button size="sm" variant="ghost" disabled={wholeSong || rangeBusy} onClick={restoreWholeSong}>
                  Restore whole song
                </Button>
              </div>
            </div>
          </div>
        )}
        <div className="mt-20">
          <Slider
            label="Audio sync"
            value={settings.audioOffsetMs}
            min={-250}
            max={250}
            step={5}
            onChange={(value) => onUpdateSettings({ audioOffsetMs: value })}
            format={formatSync}
            hint={SYNC_HINT}
          />
          <Slider
            label={meta.scrollSpeed === undefined ? 'Arrow speed' : 'Arrow speed (this song)'}
            value={meta.scrollSpeed ?? settings.scrollSpeed}
            min={1}
            max={10}
            step={0.1}
            onChange={(value) => chooseSpeed(value)}
            format={(value) => `${value.toFixed(1)} / 10`}
          />
          {meta.scrollSpeed !== undefined && (
            <Button size="sm" variant="ghost" onClick={() => chooseSpeed(undefined)}>
              Use default speed ({settings.scrollSpeed.toFixed(1)})
            </Button>
          )}
        </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,.wav,.mp3,.ogg,.m4a,.flac,.opus,.aac,.webm"
            style={{ display: 'none' }}
            onChange={(event) => {
              const chosen = event.target.files?.[0]
              event.target.value = ''
              if (chosen) void attachFile(chosen)
            }}
          />
      </Panel>

      {askRegenerate && (
        <Modal title={circleMode ? 'Regenerate circles' : 'Regenerate arrows'} onClose={() => setAskRegenerate(false)}>
          <p>
            You edited {editedCharts.map((chart) => DIFFICULTY_LABEL[chart.difficulty]).join(', ')} by hand.
            Rebuild {editedCharts.length === 1 ? 'it' : 'them'} too?
          </p>
          <div className="row gap-8 wrap mt-16">
            <Button variant="primary" onClick={() => void newVariation(false)}>
              Keep my edits
            </Button>
            <Button variant="danger" onClick={() => void newVariation(true)}>
              Rebuild all
            </Button>
          </div>
        </Modal>
      )}
    </div>
  )
}

