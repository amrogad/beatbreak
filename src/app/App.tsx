/**
 * Application shell: routing, the library cache, toasts and settings wiring.
 *
 * Routing is a small explicit union rather than a router dependency — there are six screens and
 * exactly one flow (import → setup → play → results), and keeping it explicit makes the resource
 * ownership obvious: a screen owns its audio engine and disposes it on unmount because the route
 * (and therefore the component) actually changes.
 */
import React, { useCallback, useEffect, lazy, useMemo, useRef, useState, Suspense, useSyncExternalStore } from 'react'
import type { Chart, Difficulty, RunResults, SongMeta } from '../core/types'
import { createTestSongFile } from '../audio/synth'
import { getAudioContext, resumeAudioContext } from '../audio/engine'
import { configureMenuMusic, playMenuMusic, previewStart, stopMenuMusic } from '../audio/menuMusic'
import { loadSongBundle } from '../store/library'
import { attachUiSounds, configureSfx } from '../audio/sfx'
import { listRuns, deleteSong as deleteSongRecord, saveRun, updateSong } from '../store/repository'
import type { StoredRun } from '../store/db'
import { bestRunFor, listCharts } from '../store/repository'
import { settingsStore } from '../store/settings'
import type { Settings } from '../store/settings'
import { runtime } from './runtime'
import { HomeScreen } from './screens/HomeScreen'
import { SetupScreen } from './screens/SetupScreen'
import { GameScreen } from './screens/GameScreen'
import { ResultsScreen } from './screens/ResultsScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { AboutScreen } from './screens/AboutScreen'
const EditorScreen = lazy(() =>
  import('./screens/EditorScreen').then((module) => ({ default: module.EditorScreen })),
)
import { loadBestScores } from './screens/bestScores'
import type { BestScores } from './screens/bestScores'
import { Button, Icon, Spinner } from './components'
import { ErrorBoundary } from './ErrorBoundary'
import { Tutorial } from './Tutorial'
import { listSongs } from '../store/repository'
import { isIndexedDbAvailable } from '../store/db'

type Route =
  | { name: 'home' }
  | { name: 'setup'; file: File | null; songId: string | null; attempt: number }
  | { name: 'game'; songId: string; chartId: string; autoPlay: boolean; runKey: number }
  | {
      name: 'results'
      results: RunResults
      songId: string
      chartId: string
      previousBest: StoredRun | null
      isNewBest: boolean
      history: StoredRun[]
    }
  | { name: 'settings' }
  | { name: 'about' }
  | { name: 'editor'; songId: string; chartId: string }

interface Toast {
  id: number
  message: string
  tone: 'info' | 'error' | 'success'
}

export function App(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  )
}

function AppShell(): React.JSX.Element {
  const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get)
  const [route, setRoute] = useState<Route>({ name: 'home' })
  const [songs, setSongs] = useState<SongMeta[]>([])
  const [bestScores, setBestScores] = useState<BestScores>({})
  const [loading, setLoading] = useState(true)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [tutorialOpen, setTutorialOpen] = useState(!settings.tutorialSeen)
  const toastIdRef = useRef(0)

  const storageAvailable = useMemo(() => isIndexedDbAvailable(), [])

  const toast = useCallback((message: string, tone: 'info' | 'error' | 'success' = 'info') => {
    const id = ++toastIdRef.current
    setToasts((current) => [...current.slice(-2), { id, message, tone }])
    window.setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), 6000)
  }, [])

  const refreshLibrary = useCallback(async () => {
    try {
      const [nextSongs, nextBest] = await Promise.all([listSongs(), loadBestScores()])
      setSongs(nextSongs)
      setBestScores(nextBest)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    void refreshLibrary()
  }, [refreshLibrary])

  // Theme lives on <html> so every surface (screens, overlays, toasts) follows it without props.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  useEffect(() => {
    configureSfx({ enabled: settings.uiSounds, volume: settings.volume })
  }, [settings.uiSounds, settings.volume])

  // One delegated listener pair for the whole app: buttons click, selects pop, toggles tick.
  useEffect(() => {
    const detach = attachUiSounds()
    return detach
  }, [])

  useEffect(() => {
    configureMenuMusic({ enabled: settings.menuMusic, volume: settings.volume })
  }, [settings.menuMusic, settings.volume])

  // Browsers keep audio locked until the first click or key press; unlock it then so the menu
  // music can start.
  useEffect(() => {
    const unlock = (): void => {
      void resumeAudioContext().catch(() => undefined)
    }
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  // Menu music: the song being set up, or on the other menus the latest song (the demo track with
  // an empty library). The topbar's music button mutes it. The results stay quiet: the song
  // starting again right after it ended sounded like a replay.
  useEffect(() => {
    if (!settings.menuMusic) return
    if (route.name === 'game' || route.name === 'editor' || route.name === 'results') {
      stopMenuMusic(0.3)
      return
    }
    if (route.name === 'setup' && !route.songId) return
    const latest = [...songs].sort((a, b) => (b.lastPlayedAt || b.createdAt) - (a.lastPlayedAt || a.createdAt))[0]
    const songId = route.name === 'setup' ? route.songId : latest?.id ?? null
    let cancelled = false
    if (!songId) {
      void loadMenuTheme()
        .then((buffer) => {
          if (buffer && !cancelled) playMenuMusic('theme', buffer, 0, true)
        })
        .catch(() => undefined)
      return () => {
        cancelled = true
      }
    }
    const start = (buffer: AudioBuffer, duration: number, sections: { start: number; energy: number }[]): void => {
      if (!cancelled) playMenuMusic(songId, buffer, previewStart(duration, sections))
    }
    const cached = runtime.get(songId)
    if (cached?.buffer) {
      start(cached.buffer, cached.meta.duration, cached.meta.analysis.sections)
    } else {
      void loadSongBundle(songId)
        .then((bundle) => {
          if (!bundle?.buffer) return
          runtime.put(bundle)
          start(bundle.buffer, bundle.meta.duration, bundle.meta.analysis.sections)
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [route, songs, settings.menuMusic])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    settingsStore.update(patch)
  }, [])

  const showTutorial = useCallback(() => setTutorialOpen(true), [])
  const closeTutorial = useCallback(() => {
    setTutorialOpen(false)
    if (!settings.tutorialSeen) updateSettings({ tutorialSeen: true })
  }, [settings.tutorialSeen, updateSettings])

  /* --------------------------------------------------------------- actions */

  const startImport = useCallback((file: File) => {
    setRoute((current) => ({ name: 'setup', file, songId: null, attempt: current.name === 'setup' ? current.attempt + 1 : 0 }))
  }, [])

  const startDemo = useCallback(() => {
    try {
      const { file } = createTestSongFile({ bpm: 128, bars: 24, sampleRate: 32000, melody: true })
      startImport(file)
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [startImport, toast])

  const openSong = useCallback((songId: string) => {
    setRoute({ name: 'setup', file: null, songId, attempt: 0 })
  }, [])

  const handleDeleteSong = useCallback(
    async (songId: string) => {
      try {
        await deleteSongRecord(songId)
        runtime.evict(songId)
        await refreshLibrary()
        toast('Song deleted.', 'success')
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error')
      }
    },
    [refreshLibrary, toast],
  )

  const clearAllSongs = useCallback(async () => {
    try {
      for (const song of songs) {
        await deleteSongRecord(song.id)
        runtime.evict(song.id)
      }
      await refreshLibrary()
      toast('All songs removed.', 'success')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }, [refreshLibrary, songs, toast])

  const startGame = useCallback(
    async (request: { songId: string; chartId: string; difficulty: Difficulty; autoPlay: boolean }) => {
      const bundle = runtime.get(request.songId)
      if (!bundle || !bundle.buffer) {
        toast('Audio is not loaded. Re-attach the file in song setup before playing.', 'error')
        return
      }
      const chart = bundle.charts.find((candidate) => candidate.id === request.chartId)
      if (!chart) {
        toast('That chart no longer exists.', 'error')
        return
      }
      setRoute((current) => ({
        name: 'game',
        songId: request.songId,
        chartId: request.chartId,
        autoPlay: request.autoPlay,
        runKey: current.name === 'game' ? current.runKey + 1 : 0,
      }))
    },
    [toast],
  )

  const finishRun = useCallback(
    async (results: RunResults) => {
      const bundle = runtime.get(results.songId)
      const song = bundle?.meta ?? songs.find((candidate) => candidate.id === results.songId)
      const chart = bundle?.charts.find((candidate) => candidate.id === results.chartId) ?? null
      let previousBest: StoredRun | null = null
      let isNewBest = false
      let history: StoredRun[] = []
      try {
        previousBest = (await bestRunFor(results.songId, results.difficulty)) ?? null
        if (!results.autoPlay) {
          isNewBest = !results.failed && results.score > 0 && (!previousBest || results.score > previousBest.score)
          await saveRun({
            songId: results.songId,
            songTitle: song?.title ?? '',
            artist: song?.artist ?? '',
            results,
          })
          await updateSong(results.songId, { lastPlayedAt: Date.now() })
          history = (await listRuns(results.songId)).filter((run) => run.chartId === results.chartId).slice(0, 5)
          await refreshLibrary()
        }
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error')
      }
      if (!song || !chart) {
        toast('Song or chart went missing; returning home.', 'error')
        setRoute({ name: 'home' })
        return
      }
      setRoute({ name: 'results', results, songId: results.songId, chartId: results.chartId, previousBest, isNewBest, history })
    },
    [refreshLibrary, songs, toast],
  )

  const handleChartsChanged = useCallback((songId: string, charts: Chart[]) => {
    runtime.setCharts(songId, charts)
  }, [])

  /* ------------------------------------------------------------------ render */

  const backHome = useCallback(() => setRoute({ name: 'home' }), [])

  const renderRoute = (): React.JSX.Element => {
    switch (route.name) {
      case 'home':
        return (
          <HomeScreen
            songs={songs}
            loading={loading}
            bestScores={bestScores}
            storageAvailable={storageAvailable}
            onImport={startImport}
            onPlayDemo={startDemo}
            onOpenSong={openSong}
            onDeleteSong={(songId) => void handleDeleteSong(songId)}
            onClearAll={() => void clearAllSongs()}
          />
        )
      case 'setup':
        return (
          <SetupScreen
            key={`setup-${route.songId ?? 'file'}-${route.attempt}`}
            file={route.file}
            songId={route.songId}
            settings={settings}
            bestScores={bestScores}
            onBack={backHome}
            onRetry={() => setRoute((current) => ({ ...current, attempt: (current as { attempt: number }).attempt + 1 }))}
            onPlay={(request) => void startGame(request)}
            onOpenEditor={(songId, chartId) => setRoute({ name: 'editor', songId, chartId })}
            onBundleReady={() => void refreshLibrary()}
            onToast={toast}
          />
        )
      case 'game': {
        const bundle = runtime.get(route.songId)
        const chart = bundle?.charts.find((candidate) => candidate.id === route.chartId)
        if (!bundle?.buffer || !chart) {
          return (
            <div className="page narrow">
              <div className="panel">
                <h2>Cannot start this run</h2>
                <p className="muted small mt-8">The audio or chart is no longer in memory.</p>
                <div className="mt-16">
                  <Button variant="primary" onClick={backHome}>
                    Back
                  </Button>
                </div>
              </div>
            </div>
          )
        }
        return (
          <GameScreen
            key={`game-${route.runKey}`}
            song={bundle.meta}
            chart={chart}
            buffer={bundle.buffer}
            settings={settings}
            autoPlay={route.autoPlay}
            onFinish={(results) => void finishRun(results)}
            onExit={() => setRoute({ name: 'setup', file: null, songId: route.songId, attempt: 0 })}
            onUpdateSettings={updateSettings}
          />
        )
      }
      case 'results': {
        const bundle = runtime.get(route.songId)
        const chart = bundle?.charts.find((candidate) => candidate.id === route.chartId)
        const song = bundle?.meta ?? songs.find((candidate) => candidate.id === route.songId)
        if (!chart || !song) {
          return (
            <div className="page narrow">
              <div className="panel">
                <h2>Results unavailable</h2>
                <p className="muted small mt-8">The chart for this run could not be loaded.</p>
                <div className="mt-16">
                  <Button variant="primary" onClick={backHome}>
                    Back
                  </Button>
                </div>
              </div>
            </div>
          )
        }
        return (
          <ResultsScreen
            results={route.results}
            song={song}
            chart={chart}
            previousBest={route.previousBest}
            isNewBest={route.isNewBest}
            history={route.history}
            onRetry={() => void startGame({ songId: route.songId, chartId: route.chartId, difficulty: chart.difficulty, autoPlay: route.results.autoPlay ?? false })}
            onSetup={() => setRoute({ name: 'setup', file: null, songId: route.songId, attempt: 0 })}
            onHome={backHome}
            audioOffsetMs={settings.audioOffsetMs}
            onApplyOffset={(offsetMs) => {
              updateSettings({ audioOffsetMs: offsetMs })
              toast(`Arrow timing set to ${offsetMs} ms.`, 'success')
            }}
            onExportChart={() => {
              void (async () => {
                const { serializeChart } = await import('../chart/serialize')
                const text = serializeChart(chart, {
                  title: song.title,
                  artist: song.artist,
                  fileName: song.fileName,
                  duration: song.duration,
                })
                const blob = new Blob([text], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const link = document.createElement('a')
                link.href = url
                link.download = `${song.title.replace(/[^\w\- ]+/g, '')}-${chart.difficulty}.pulsegrid.json`
                link.click()
                URL.revokeObjectURL(url)
                toast('Chart exported as JSON.', 'success')
              })()
            }}
          />
        )
      }
      case 'settings':
        return (
          <SettingsScreen
            settings={settings}
            onUpdate={updateSettings}
            onReset={() => settingsStore.reset()}
            onBack={backHome}
            onToast={toast}
            onLibraryChanged={() => void refreshLibrary()}
          />
        )
      case 'about':
        return <AboutScreen onBack={backHome} />
      case 'editor':
        return (
          <Suspense
            fallback={
              <div className="page narrow">
                <Spinner label="Loading editor" />
              </div>
            }
          >
            <EditorScreen
              songId={route.songId}
              chartId={route.chartId}
              onBack={() => setRoute({ name: 'setup', file: null, songId: route.songId, attempt: 0 })}
              onToast={toast}
              onChartsChanged={handleChartsChanged}
            />
          </Suspense>
        )
      default:
        return <HomeScreen songs={songs} loading={loading} bestScores={bestScores} storageAvailable={storageAvailable} onImport={startImport} onPlayDemo={startDemo} onOpenSong={openSong} onDeleteSong={() => undefined} onClearAll={() => undefined} />
    }
  }

  const inGame = route.name === 'game'

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      {!inGame && (
        <header className="topbar">
          <button type="button" className="brand" onClick={backHome} aria-label="PULSEGRID - home">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 32 32" focusable="false">
                <rect x="4" y="12" width="4" height="8" fill="var(--lane-left)" />
                <rect x="10.5" y="7" width="4" height="18" fill="var(--lane-down)" />
                <rect x="17" y="9.5" width="4" height="13" fill="var(--lane-up)" />
                <rect x="23.5" y="13" width="4" height="6" fill="var(--lane-right)" />
              </svg>
            </span>
            <span className="brand-text">
              <b>PULSEGRID</b>
              <small>Rhythm Engine</small>
            </span>
          </button>
          <div className="row gap-8">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => updateSettings({ menuMusic: !settings.menuMusic })}
              aria-label={settings.menuMusic ? 'Mute menu music' : 'Play menu music'}
              title={settings.menuMusic ? 'Mute menu music' : 'Play menu music'}
            >
              <Icon name={settings.menuMusic ? 'sound' : 'muted'} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRoute({ name: 'settings' })}>
              Settings
            </Button>
            <Button variant="ghost" size="sm" onClick={showTutorial} title="How to play">
              Help
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRoute({ name: 'about' })}>
              About
            </Button>
          </div>
        </header>
      )}
      <main id="main-content">{renderRoute()}</main>
      {toasts.length > 0 && (
        <div className="toast-stack" role="status" aria-live="polite" aria-atomic="true">
          {toasts.map((entry) => (
            <div key={entry.id} className={`toast ${entry.tone}`}>
              {entry.message}
            </div>
          ))}
        </div>
      )}
      <Tutorial open={tutorialOpen} onClose={closeTutorial} />
    </div>
  )
}

let themeLoad: Promise<AudioBuffer | null> | null = null

/**
 * The menu theme while there are no songs yet: Virtual Rush by vitalezzz (CC0, OpenGameArt).
 * The OGG loops seamlessly; browsers that cannot decode it get the MP3.
 */
function loadMenuTheme(): Promise<AudioBuffer | null> {
  themeLoad ??= (async () => {
    for (const url of ['/music/menu-theme.ogg', '/music/menu-theme.mp3']) {
      try {
        const response = await fetch(url)
        if (!response.ok) continue
        return await getAudioContext().decodeAudioData(await response.arrayBuffer())
      } catch {
        // Try the next format.
      }
    }
    return null
  })()
  return themeLoad
}
