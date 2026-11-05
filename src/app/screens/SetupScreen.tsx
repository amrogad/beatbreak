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
  regenerateCharts,
  sameTrim,
  setSongTrim,
  trimDraftFor,
} from '../../store/library'
import { runtime } from '../runtime'
import { saveAnalysis, saveAudio, updateSong } from '../../store/repository'
import type { Settings } from '../../store/settings'
import { decodeAudioFile } from '../../audio/engine'
import { downmixMono } from '../../audio/analyze'
import { autoTrimWindow } from '../../audio/trim'
import { DEMO_FILE_NAME } from '../../audio/synth'
import { planForMeta } from '../../core/edit'
import { rateSong } from '../../chart/generate'
import { AnalysisClient, AnalysisCancelledError } from '../../workers/analysisClient'
import { BackButton, Button, Panel, ProgressBar, Spinner } from '../components'
import { formatDuration, formatPercent } from '../format'
import type { BestScores } from './bestScores'

type Phase = 'idle' | 'importing' | 'ready' | 'error'

export interface SetupScreenProps {
  file: File | null
  songId: string | null
  settings: Settings
  bestScores: BestScores
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

const DIFFICULTY_ORDER: Difficulty[] = [...DIFFICULTIES]

export function SetupScreen({
  file,
  songId,
  settings,
  bestScores,
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
  const [artist, setArtist] = useState('')
  const [titleDirty, setTitleDirty] = useState(false)
  const [rangeBusy, setRangeBusy] = useState(false)
  const [variationBusy, setVariationBusy] = useState(false)
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
  const duration = bundle?.meta.duration ?? 0
  const analysis = bundle?.analysis ?? null

  const adopt = useCallback((next: SongBundle) => {
    runtime.put(next)
    setBundle(next)
    setTitle(next.meta.title)
    setArtist(next.meta.artist)
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
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        if (caught instanceof AnalysisCancelledError || (caught instanceof DOMException && caught.name === 'AbortError')) {
          onBack()
          return
        }
        setError(caught instanceof Error ? caught.message : String(caught))
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
      setArtist(existing.meta.artist)
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
        setArtist(loaded.meta.artist)
        setPhase('ready')
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setError(caught instanceof Error ? caught.message : String(caught))
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
    const fallback = settings.defaultDifficulty === 'auto' ? recommended : settings.defaultDifficulty
    setDifficulty(bundleMeta.preferredDifficulty ?? fallback ?? 'normal')
  }, [bundleMeta, recommended, settings.defaultDifficulty])

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

  const saveDetails = useCallback(async () => {
    if (!bundle) return
    const updated = await updateSong(bundle.meta.id, {
      title: title.trim() || bundle.meta.title,
      artist: artist.trim(),
    })
    if (!updated) {
      onToast('Could not save: the song is no longer in the library.', 'error')
      return
    }
    setBundle((current) => (current ? { ...current, meta: updated } : current))
    setTitle(updated.title)
    setArtist(updated.artist)
    setTitleDirty(false)
    onToast('Song details saved.', 'success')
  }, [artist, bundle, onToast, title])

  const applyRange = useCallback(
    async (mode: 'auto' | 'full') => {
      if (!bundle || rangeBusy) return
      if (!analysis) {
        onToast('Re-attach the audio file to change the song range.', 'error')
        return
      }
      setRangeBusy(true)
      try {
        const trim =
          mode === 'full'
            ? { start: 0, end: bundle.meta.duration, cuts: [] }
            : (() => {
                const auto = autoTrimWindow(analysis, bundle.meta.duration, bundle.meta.peaks)
                return { start: auto.window.start, end: auto.window.end, cuts: [] }
              })()
        const updated = await setSongTrim(bundle.meta.id, trim)
        if (!updated) throw new Error('The song is no longer in the library.')
        const regenerated = await regenerateCharts({
          analysis,
          duration: updated.duration,
          songId: updated.id,
          title: updated.title,
          bpm: updated.analysis.bpm,
          offset: updated.analysis.offset,
          edit: planForMeta(updated),
          existing: bundle.charts,
        })
        adopt({ ...bundle, meta: updated, charts: regenerated })
        const trimmedStart = trim.start > 0.05
        const trimmedEnd = trim.end < updated.duration - 0.05
        onToast(
          mode === 'full'
            ? 'The whole song now plays. Arrows rebuilt for the full length.'
            : trimmedStart || trimmedEnd
              ? 'Silent edges skipped. Arrows rebuilt, with the song’s ending kept.'
              : 'No silent edges found — the whole song plays. Arrows rebuilt.',
          'success',
        )
      } catch (caught) {
        onToast(caught instanceof Error ? caught.message : String(caught), 'error')
      } finally {
        setRangeBusy(false)
      }
    },
    [adopt, analysis, bundle, onToast, rangeBusy],
  )

  const newVariation = useCallback(async () => {
    if (!bundle || variationBusy) return
    if (!analysis) {
      onToast('Re-attach the audio file to build a new arrow variation.', 'error')
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
        bpm: updated.analysis.bpm,
        offset: updated.analysis.offset,
        edit: planForMeta(updated),
        salt,
        existing: bundle.charts,
      })
      adopt({ ...bundle, meta: updated, charts: regenerated })
      onToast(
        bundle.charts.some((chart) => chart.edited)
          ? 'New arrows built. Charts you edited by hand were kept.'
          : 'New arrows built. Your old high scores stay on the song.',
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
        <Panel title={file ? (file.name === DEMO_FILE_NAME ? 'Generating audio track' : `Building charts for ${file.name}`) : 'Loading song'}>
          <div className="row-between gap-16">
            <Spinner label={progress.stage} />
            <span className="mono small">{Math.round(progress.fraction * 100)}%</span>
          </div>
          <div className="mt-12">
            <ProgressBar fraction={progress.fraction} />
          </div>
          <p className="muted small mt-16">
            PULSEGRID listens for the beat, builds four difficulty levels, and starts you on the
            one that fits the song.
          </p>
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
  const autoTrim = analysis ? autoTrimWindow(analysis, meta.duration, meta.peaks).window : null
  const isAutoRange =
    !wholeSong &&
    trim.cuts.length === 0 &&
    autoTrim !== null &&
    sameTrim(trim, { start: autoTrim.start, end: autoTrim.end, cuts: [] })
  const rangeLabel = wholeSong
    ? `Whole song - ${formatDuration(meta.duration)}`
    : isAutoRange
      ? `${formatDuration(trim.start)}–${formatDuration(trim.end)} - silent edges skipped`
      : `${formatDuration(trim.start)}–${formatDuration(trim.end)} - custom range`
  const playLength = Math.max(0, trim.end - trim.start)

  return (
    <div className="page narrow">
      <div className="row-between wrap gap-12">
        <div>
          <div className="eyebrow">Choose a difficulty</div>
          <div className="title-row mt-12">
            <BackButton onClick={onBack} />
            <h1>{meta.title}</h1>
          </div>
          <p className="muted small">
            {meta.artist ? `${meta.artist} - ` : ''}
            {formatDuration(meta.duration)} - {charts.length} charts
          </p>
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

      <Panel>
        <div className="difficulty-grid" role="radiogroup" aria-label="Difficulty">
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
                <span className="difficulty-copy">{DIFFICULTY_COPY[item]}</span>
                <span className="difficulty-meta">
                  {chart ? `${chart.stats.noteCount.toLocaleString('en-US')} arrows` : 'Not available'}
                  {holds > 0 ? ` - ${holds} holds` : ''}
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
          <div>
            <strong>{selectedChart ? `${selectedChart.stats.noteCount.toLocaleString('en-US')} arrows` : 'No chart'}</strong>
            <span className="muted small"> - {formatDuration(playLength)} of play</span>
          </div>
          <div className="row gap-8 wrap">
            <Button
              size="lg"
              variant="ghost"
              disabled={!selectedChart}
              onClick={() => selectedChart && onOpenEditor(meta.id, selectedChart.id)}
            >
              Edit arrows
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

      <Panel title="Song options" subtitle="Defaults are already set.">
        <div className="row-between wrap gap-12">
          <div>
            <strong>Song range</strong>
            <p className="muted small">{rangeLabel}</p>
          </div>
          <div className="row gap-8 wrap">
            <Button
              size="sm"
              variant={isAutoRange ? 'primary' : 'ghost'}
              disabled={rangeBusy || !analysis}
              onClick={() => void applyRange('auto')}
              title={analysis ? 'Skip near-silent edges; the song ending is kept' : 'Re-attach the audio to change this'}
            >
              Trim silence
            </Button>
            <Button
              size="sm"
              variant={wholeSong ? 'primary' : 'ghost'}
              disabled={rangeBusy || !analysis}
              onClick={() => void applyRange('full')}
              title={analysis ? 'Play the file from start to finish' : 'Re-attach the audio to change this'}
            >
              Whole song
            </Button>
          </div>
        </div>
        <p className="muted tiny mt-8">
          Trim silence only skips near-silent lead-in and lead-out. The song’s ending always plays.
        </p>

        <details className="disclosure mt-20">
          <summary>More options</summary>
          <div className="grid cols-2 mt-16">
            <label className="field">
              <span className="field-label">Title</span>
              <input
                type="text"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value)
                  setTitleDirty(true)
                }}
              />
            </label>
            <label className="field">
              <span className="field-label">Artist</span>
              <input
                type="text"
                value={artist}
                placeholder="unknown"
                onChange={(event) => {
                  setArtist(event.target.value)
                  setTitleDirty(true)
                }}
              />
            </label>
          </div>
          {titleDirty && (
            <div className="mt-12">
              <Button size="sm" onClick={() => void saveDetails()}>
                Save song details
              </Button>
            </div>
          )}

          <div className="option-row mt-20">
            <div>
              <strong>Want different arrows?</strong>
              <p className="muted small">
                Your chart stays exactly the same every time you play. Build a new variation when
                you want a fresh pattern.
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              disabled={variationBusy || !analysis}
              onClick={() => void newVariation()}
              title={analysis ? 'Rebuild all four charts with a new pattern' : 'Re-attach the audio first'}
            >
              {variationBusy ? 'Building…' : 'New arrows'}
            </Button>
          </div>

          <p className="muted tiny mt-20">
            Detected tempo {meta.analysis.bpm.toFixed(1)} BPM - {formatDuration(meta.duration)} - Audio
            {meta.audioCached ? ' saved' : ' not saved'}
          </p>

          {bundle.buffer && (
            <div className="mt-12">
              <Button size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()}>
                {attaching ? 'Reading…' : 'Replace audio file'}
              </Button>
            </div>
          )}
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
        </details>
      </Panel>
    </div>
  )
}
