/**
 * Gameplay screen.
 *
 * The synchronization contract:
 *  - `AudioContext.currentTime` is the only clock. Every frame reads the audible song position
 *    from the engine; the renderer never advances time itself.
 *  - Hit detection uses the event's own timestamp (`event.timeStamp`) mapped onto the song clock,
 *    so a busy main thread delays the *reading* of a press, not the judged timing.
 *  - Pausing stops the source, so no audio can ever continue in the background; losing focus or
 *    hiding the tab pauses automatically.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Chart, RunResults, SongMeta } from '../../core/types'
import { DIFFICULTY_COLOR, DIFFICULTY_LABEL } from '../../core/types'
import { AudioEngine, getAudioContext, resumeAudioContext } from '../../audio/engine'
import { buildEditPlan, planForMeta, toPlaybackPlan } from '../../core/edit'
import { sfxFail } from '../../audio/sfx'
import { GameSession, checkFail } from '../../game/session'
import { compensateInputLatency, windowsForDifficulty } from '../../game/judgment'
import { accuracyFromTally, finalAccuracy, gradeFor } from '../../game/score'
import { InputRouter, attachTouchLanes, describeKey } from '../../game/input'
import { PlayfieldRenderer } from '../../render/renderer'
import type { Settings } from '../../store/settings'
import { Button, Slider } from '../components'
import { formatPercent } from '../format'

export interface GameScreenProps {
  song: SongMeta
  chart: Chart
  buffer: AudioBuffer
  settings: Settings
  autoPlay: boolean
  onFinish: (results: RunResults) => void
  onExit: () => void
  onUpdateSettings: (patch: Partial<Settings>) => void
}

const COUNTDOWN_MS = 3000
/**
 * After 3-2-1 comes a short run-up, shown as GO!, while the first arrows travel up from the
 * bottom. Its length is the arrows' travel time, so nothing is on screen during the numbers.
 */
const leadInRef = { current: 900 }

export function GameScreen({
  song,
  chart,
  buffer,
  settings,
  autoPlay,
  onFinish,
  onExit,
  onUpdateSettings,
}: GameScreenProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<PlayfieldRenderer | null>(null)
  const engineRef = useRef<AudioEngine | null>(null)
  const sessionRef = useRef<GameSession | null>(null)
  const routerRef = useRef<InputRouter | null>(null)
  const detachTouchRef = useRef<(() => void) | null>(null)
  const rafRef = useRef(0)
  const finishedRef = useRef(false)
  const failedRef = useRef(false)
  const runCompleteRef = useRef(false)
  const pausedRef = useRef(false)
  const judgingRef = useRef(false)
  const countdownStartRef = useRef(0)
  const countdownPausedAtRef = useRef<number | null>(null)
  const engagingRef = useRef(false)
  const resultTimersRef = useRef<number[]>([])
  const settingsRef = useRef(settings)
  const autoPlayRef = useRef(autoPlay)
  const onFinishRef = useRef(onFinish)

  const [paused, setPaused] = useState(false)
  const [hud, setHud] = useState({ score: 0, combo: 0, accuracy: 1, judged: 0 })
  // Touch devices have no keyboard: the hint should teach the gesture that actually works.
  const [touchOnly] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)

  // Every settings update rebuilds `customWindows`, so the memo keys on its values. A new object
  // here would rebuild the whole run (the volume slider in the pause menu used to do that).
  const customWindowsKey = JSON.stringify(settings.customWindows)
  const windows = useMemo(
    () => windowsForDifficulty(settings.windowPreset, chart.difficulty, settings.customWindows),
    [settings.windowPreset, customWindowsKey, chart.difficulty],
  )

  /**
   * The playable arrangement: the trimmed window minus removed sections, spliced on bar lines.
   * Notes stay in original-audio time; the engine's clock jumps over cuts, so judging, the
   * renderer and the chart all keep using the same numbers they were generated with.
   */
  const playPlan = useMemo(() => planForMeta(song), [song])
  const playbackPlan = useMemo(() => toPlaybackPlan(playPlan), [playPlan])

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])
  useEffect(() => {
    autoPlayRef.current = autoPlay
  }, [autoPlay])
  useEffect(() => {
    onFinishRef.current = onFinish
  }, [onFinish])

  /* ---------------------------------------------------------------- callbacks */

  const pause = useCallback(() => {
    if (finishedRef.current || pausedRef.current) return
    // Freeze the countdown too, not just the audio. Otherwise pausing before the first note and
    // resuming a moment later starts the song mid-countdown with no run-up.
    if (!engagingRef.current && performance.now() - countdownStartRef.current < COUNTDOWN_MS + leadInRef.current) {
      countdownPausedAtRef.current = performance.now()
    }
    engineRef.current?.pause()
    pausedRef.current = true
    judgingRef.current = false
    // The pause overlay is the only place React needs the score, so snapshot it here instead of
    // re-rendering the screen on every judgement during play.
    const state = sessionRef.current?.scoreState
    if (state) setHud({ score: state.score, combo: state.combo, accuracy: state.accuracy, judged: state.judged })
    setPaused(true)
  }, [])

  const resume = useCallback(() => {
    if (finishedRef.current || !pausedRef.current) return
    if (countdownPausedAtRef.current !== null) {
      countdownStartRef.current += performance.now() - countdownPausedAtRef.current
      countdownPausedAtRef.current = null
    }
    engineRef.current?.resume()
    pausedRef.current = false
    judgingRef.current = true
    setPaused(false)
  }, [])

  const togglePause = useCallback(() => {
    if (pausedRef.current) resume()
    else pause()
  }, [pause, resume])

  const finishRun = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true
    const session = sessionRef.current
    if (!session) return
    judgingRef.current = false
    engineRef.current?.pause()
    const state = session.scoreState
    const failed = failedRef.current
    // A failed run reports the performance up to the failure — StepMania shows what you actually
    // played, not a denominator padded with arrows the run never reached. A completed run has
    // every note judged, so both figures are identical there.
    const accuracy = failed
      ? accuracyFromTally(state.tally, state.judged + state.droppedHolds)
      : finalAccuracy(state.tally, state.totalNotes, state.droppedHolds)
    const results: RunResults = {
      songId: song.id,
      chartId: chart.id,
      difficulty: chart.difficulty,
      score: state.score,
      accuracy,
      bestCombo: state.bestCombo,
      tally: state.tally,
      totalNotes: state.totalNotes,
      grade: gradeFor(accuracy, failed).label,
      failed,
      createdAt: Date.now(),
      meanTimingMs: session.meanTimingMs,
      droppedHolds: state.droppedHolds,
      autoPlay: session.isAutoPlay,
    }
    // Let the outro breathe: fade the music instead of cutting it the instant the last arrow is
    // judged, then switch to results after the fade has finished. The playfield stays visible (no
    // "loading" overlay) so the ending is not hidden.
    engineRef.current?.fadeOut(failed ? 0.3 : 1.1)
    resultTimersRef.current.push(
      window.setTimeout(() => engineRef.current?.pause(), failed ? 320 : 1150),
      window.setTimeout(() => onFinishRef.current(results), failed ? 750 : 1900),
    )
  }, [chart.difficulty, chart.id, song.id])

  const restart = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    for (const timer of resultTimersRef.current) window.clearTimeout(timer)
    resultTimersRef.current = []
    engineRef.current?.dispose()
    engineRef.current = null
    finishedRef.current = false
    failedRef.current = false
    runCompleteRef.current = false
    pausedRef.current = false
    judgingRef.current = false
    engagingRef.current = false
    countdownPausedAtRef.current = null
    session.reset()
    // Re-run the countdown instead of jumping straight into the first notes; an instant restart
    // used to drop the opening arrows on the receptors with no time to read them.
    countdownStartRef.current = performance.now()
    setPaused(false)
    setHud({ score: 0, combo: 0, accuracy: 1, judged: 0 })
    rendererRef.current?.setChart(buffer.duration, chart)
  }, [buffer.duration, chart])

  const toggleFullscreen = useCallback(async () => {
    const root = rootRef.current
    if (!root) return
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await root.requestFullscreen()
    } catch {
      // Browsers can refuse fullscreen (no user gesture, or embedded in an iframe).
    }
  }, [])

  const pressLane = useCallback((lane: 0 | 1 | 2 | 3, eventTimeMs: number) => {
    const session = sessionRef.current
    const engine = engineRef.current
    const renderer = rendererRef.current
    renderer?.press(lane)
    if (!session || !engine || !judgingRef.current || session.isAutoPlay) return
    const now = performance.now()
    const judgeMs = engine.judgeTime * 1000
    session.handleTap(lane, compensateInputLatency(eventTimeMs, judgeMs, now))
  }, [])

  const releaseLane = useCallback((lane: 0 | 1 | 2 | 3, eventTimeMs: number) => {
    const renderer = rendererRef.current
    renderer?.release(lane)
    const session = sessionRef.current
    const engine = engineRef.current
    // A release while paused still counts: otherwise letting go during the pause menu and not
    // pressing again would complete the hold with full credit.
    if (!session || !engine || finishedRef.current || session.isAutoPlay) return
    const now = performance.now()
    // Releasing starts the StepMania hold-life drain (250 ms). Pressing the lane again refills
    // it; if it runs out before the tail the session scores a LetGo (miss).
    session.releaseLane(lane, compensateInputLatency(eventTimeMs, engine.judgeTime * 1000, now))
  }, [])

  /* ------------------------------------------------------------------- setup */

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let disposed = false

    // Optional fullscreen-on-play. Requested immediately after mount, while the click that
    // started the run is still a fresh user gesture for the browser.
    const root = rootRef.current
    if (settingsRef.current.displayMode === 'fullscreen' && root && !document.fullscreenElement) {
      void root.requestFullscreen().catch(() => undefined)
    }

    const renderer = new PlayfieldRenderer(canvas, {
      scrollSpeed: settingsRef.current.scrollSpeed,
      noteScale: settingsRef.current.noteScale,
      laneStyle: settingsRef.current.laneStyle,
      noteShape: settingsRef.current.noteShape,
      scrollDirection: settingsRef.current.scrollDirection,
      theme: settingsRef.current.theme,
      arrowColors: settingsRef.current.arrowColors,
      holdEndArrow: settingsRef.current.holdMode !== 'hold',
      columnColors: settingsRef.current.columnColors,
      reducedMotion: settingsRef.current.reducedMotion,
    })
    rendererRef.current = renderer
    renderer.setChart(buffer.duration, chart)
    renderer.resize()
    const observer = new ResizeObserver(() => renderer.resize())
    observer.observe(canvas)

    const session = new GameSession({
      chart,
      windows,
      autoPlay: autoPlayRef.current,
      holdMode: settingsRef.current.holdMode,
      tailMs: 900,
      onJudgment: (event) => {
        // StepMania plays no hit sounds: the song is the feedback. The renderer's hit particles
        // and judgment text carry the timing instead.
        renderer.notify(event, session.scoreState.combo)
      },
      onHoldComplete: (lane) => renderer.holdComplete(lane),
      onComplete: () => {
        runCompleteRef.current = true
        // A failed run stops at the failure and goes to results immediately. A cleared chart
        // waits for the audio window to finish, so the outro is heard instead of the results
        // dialog appearing on top of the final chord.
        if (failedRef.current) finishRun()
      },
    })
    sessionRef.current = session

    const countdownRemaining = (): number => {
      const now = countdownPausedAtRef.current ?? performance.now()
      return Math.max(0, COUNTDOWN_MS + leadInRef.current - (now - countdownStartRef.current))
    }
    countdownStartRef.current = performance.now()

    const engage = async (): Promise<void> => {
      await resumeAudioContext()
      if (disposed) return
      const engine = new AudioEngine(getAudioContext(), buffer, {
        volume: settingsRef.current.volume,
        // The run ends at the window end, not the file end: a trimmed tail must not score misses.
        // The song is over at this point, so any arrow that was never reached is a miss — the
        // failure path is different: it stops where the rule was met and leaves the rest unplayed.
        onEnded: () => {
          const active = sessionRef.current
          if (!active) return
          // If the audio window ends before every note was reached, the rest are misses. A run
          // that already cleared the chart keeps its score and simply waits for this moment.
          if (!active.isFinished) active.forfeit()
          if (runCompleteRef.current || active.isFinished) finishRun()
        },
      })
      engineRef.current = engine
      engine.play(playPlan.windowStart, undefined, playbackPlan)
      judgingRef.current = true
    }

    const loop = (): void => {
      if (disposed) return
      const activeSession = sessionRef.current
      const engine = engineRef.current
      if (!activeSession || !engine) {
        // Countdown phase: draw *before* the song starts, so the playfield is empty and the first
        // arrows rise from the bottom as the countdown reaches zero. The clock counts down to
        // the start of the playable window, not to 0: a trimmed song starts later in the file,
        // and counting to 0 made its first arrows pop up mid-screen on GO.
        leadInRef.current = renderer.leadInMs()
        const remaining = countdownRemaining()
        renderer.render(activeSession ?? session, playPlan.windowStart * 1000 - remaining, {
          score: 0,
          combo: 0,
          accuracy: 1,
          progress: 0,
          countdownMs: pausedRef.current ? null : remaining - leadInRef.current,
          paused: pausedRef.current,
          autoPlay: autoPlayRef.current,
          showStats: settingsRef.current.showStats,
          title: song.title,
          subtitle: DIFFICULTY_LABEL[chart.difficulty].toUpperCase(),
        subtitleColor: DIFFICULTY_COLOR[chart.difficulty],
        })
        // The countdown is driven by this loop, not a timer: no React re-renders during it, and
        // audio starts on the exact frame the number reaches zero.
        if (!disposed && !pausedRef.current && !engagingRef.current && remaining <= 0) {
          engagingRef.current = true
          void engage()
        }
        rafRef.current = requestAnimationFrame(loop)
        return
      }
      // One clock for everything: the judged time (what the player hears, minus device latency and
      // their calibration) also positions the notes, so a note on the receptor is exactly delta 0.
      // StepMania's global offset shifts the chart against the audio the same way.
      const judgeMs = engine.judgeTime * 1000
      activeSession.update(judgeMs)
      const state = activeSession.scoreState
      renderer.render(activeSession, Math.max(0, judgeMs), {
        score: state.score,
        combo: state.combo,
        accuracy: state.accuracy,
        progress: engine.planDuration > 0 ? Math.min(1, Math.max(0, engine.planTime / engine.planDuration)) : 0,
        countdownMs: null,
        paused: false,
        autoPlay: activeSession.isAutoPlay,
        showStats: settingsRef.current.showStats,
        title: song.title,
        subtitle: DIFFICULTY_LABEL[chart.difficulty].toUpperCase(),
        subtitleColor: DIFFICULTY_COLOR[chart.difficulty],
      })
      if (!failedRef.current && !autoPlayRef.current && checkFail(settingsRef.current.failRule, state)) {
        failedRef.current = true
        sfxFail()
        activeSession.forfeit(judgeMs)
      }
      // The chart can complete before the audio window does (especially with a whole-song ending
      // or a long outro). Keep drawing and let the music play until the window really ends.
      if (
        runCompleteRef.current &&
        !failedRef.current &&
        !finishedRef.current &&
        engine.planDuration > 0 &&
        engine.planTime >= engine.planDuration - 0.05
      ) {
        finishRun()
      }
      rafRef.current = requestAnimationFrame(loop)
    }

    rafRef.current = requestAnimationFrame(loop)

    routerRef.current = new InputRouter(
      window,
      {
        onLaneDown: (lane, eventTimeMs) => pressLane(lane, eventTimeMs),
        onLaneUp: (lane, eventTimeMs) => releaseLane(lane, eventTimeMs),
        onPause: () => togglePause(),
        onRestart: () => restart(),
        onFullscreen: () => void toggleFullscreen(),
      },
      {
        keyMap: settingsRef.current.keyMap,
        controls: settingsRef.current.controls,
        enabled: () => !finishedRef.current && !pausedRef.current,
      },
    )

    detachTouchRef.current = attachTouchLanes(canvas, {
      onLaneDown: (lane, eventTimeMs) => pressLane(lane, eventTimeMs),
      onLaneUp: (lane, eventTimeMs) => releaseLane(lane, eventTimeMs),
    })

    // Audio must never keep playing in a background tab: hiding the tab pauses the run.
    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden') return
      if (engineRef.current?.isPlaying || (!engineRef.current && !engagingRef.current)) pause()
    }
    // Leaving during the countdown pauses too; otherwise the song starts while nobody is looking.
    const onBlur = (): void => {
      if (engineRef.current?.isPlaying || (!engineRef.current && !engagingRef.current)) pause()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlur)

    return () => {
      disposed = true
      for (const timer of resultTimersRef.current) window.clearTimeout(timer)
      resultTimersRef.current = []
      observer.disconnect()
      cancelAnimationFrame(rafRef.current)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      if (document.fullscreenElement === rootRef.current) void document.exitFullscreen().catch(() => undefined)
      detachTouchRef.current?.()
      detachTouchRef.current = null
      routerRef.current?.dispose()
      routerRef.current = null
      engineRef.current?.dispose()
      engineRef.current = null
      sessionRef.current = null
      rendererRef.current = null
    }
  }, [buffer, chart, finishRun, pause, playPlan, playbackPlan, pressLane, releaseLane, restart, song.title, toggleFullscreen, togglePause, windows])

  /* --------------------------------------------------------- live settings */

  useEffect(() => {
    engineRef.current?.setVolume(settings.volume)
    rendererRef.current?.setSettings({
      scrollSpeed: settings.scrollSpeed,
      noteScale: settings.noteScale,
      laneStyle: settings.laneStyle,
      noteShape: settings.noteShape,
      scrollDirection: settings.scrollDirection,
      theme: settings.theme,
      arrowColors: settings.arrowColors,
      holdEndArrow: settings.holdMode !== 'hold',
      columnColors: settings.columnColors,
      reducedMotion: settings.reducedMotion,
    })
  }, [settings])

  useEffect(() => {
    sessionRef.current?.setAutoPlay(autoPlay)
  }, [autoPlay])

  const laneKeys = (slot: number): string =>
    [settings.keyMap.left, settings.keyMap.down, settings.keyMap.up, settings.keyMap.right]
      .map((keys) => describeKey(keys[slot] ?? keys[0]))
      .join(' ')

  return (
    <div className="game-root" ref={rootRef}>
      <canvas
        className="game-canvas"
        ref={canvasRef}
        role="img"
        aria-label="Rhythm game playfield with four arrow lanes"
      />

      {autoPlay && !paused && (
        <div className="game-top-left">
          <span className="chip">AUTO-PLAY</span>
        </div>
      )}
      <div className="game-top-right">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void toggleFullscreen()}
          title={`Fullscreen (${describeKey(settings.controls.fullscreen[0])})`}
        >
          ⛶
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={togglePause}
          title={`Pause (${describeKey(settings.controls.pause[0])})`}
        >
          ❚❚
        </Button>
      </div>

      {paused && (
        <div className="game-overlay">
          <div className="panel">
            <h2>Paused</h2>
            <p className="muted small mt-8">
              {song.title} · {DIFFICULTY_LABEL[chart.difficulty]}
            </p>
            <div className="pause-stats">
              <div className="stat">
                <span className="stat-label">Score</span>
                <span className="stat-value">{hud.score.toLocaleString('en-US')}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Accuracy</span>
                <span className="stat-value">{formatPercent(hud.accuracy, 2)}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Combo</span>
                <span className="stat-value">{hud.combo}</span>
              </div>
            </div>
            <div className="col gap-12">
              <Button variant="primary" onClick={resume}>
                Resume ({describeKey(settings.controls.pause[0])})
              </Button>
              <Button onClick={restart}>Restart ({describeKey(settings.controls.restart[0])})</Button>
              <Button variant="ghost" onClick={onExit}>
                Quit to song setup
              </Button>
            </div>
            <div className="hr" />
            <div className="col gap-12">
              <Slider
                label="Volume"
                value={settings.volume}
                min={0}
                max={1}
                step={0.01}
                onChange={(value) => onUpdateSettings({ volume: value })}
                format={(value) => `${Math.round(value * 100)}%`}
              />
            </div>
          </div>
        </div>
      )}

      <div className="game-hint">
        {autoPlay
          ? 'Auto-play: watch the arrows play themselves'
          : touchOnly
            ? 'Tap each lane as its arrow reaches the target'
            : `${laneKeys(0)} or ${laneKeys(1)} to hit · ${describeKey(settings.controls.pause[0])} pause · ${describeKey(settings.controls.restart[0])} restart`}
      </div>
    </div>
  )
}
