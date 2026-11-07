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
import { AudioEngine, estimateOutputLatency, getAudioContext, resumeAudioContext } from '../../audio/engine'
import { isCut, planForMeta, toPlaybackPlan } from '../../core/edit'
import { sfxFail } from '../../audio/sfx'
import { GameSession, checkFail } from '../../game/session'
import { CircleSession, HIT_SLACK, TOUCH_HIT_SLACK } from '../../game/circleSession'
import { approachForSpeed, circleWindows, placeCircles } from '../../chart/circles'
import { compensateInputLatency, judgmentWindows } from '../../game/judgment'
import { accuracyFromTally, finalAccuracy, gradeFor } from '../../game/score'
import { InputRouter, attachTouchLanes, describeKey } from '../../game/input'
import { PlayfieldRenderer } from '../../render/renderer'
import { arrowOffsetMs, type Settings } from '../../store/settings'
import { Icon, Button, Slider } from '../components'
import { formatPercent } from '../format'
import { runRulesKey } from './bestScores'
import { BACK_EVENT } from '../runtime'

export interface GameScreenProps {
  song: SongMeta
  chart: Chart
  /** Circle mode places its circles on this chart's rhythm (one tier easier, see CIRCLE_RHYTHM). */
  circleRhythm?: Chart
  buffer: AudioBuffer
  settings: Settings
  autoPlay: boolean
  onFinish: (results: RunResults) => void
  onExit: () => void
  onUpdateSettings: (patch: Partial<Settings>) => void
}

const COUNTDOWN_MS = 3000
/** 3-2-1 after Resume, so the hands are back on the keys before the music is. */
const RESUME_RUNUP_MS = 3000
/** How long a first press of Restart or Quit waits for the second one. */
const CONFIRM_MS = 2500
/**
 * After 3-2-1 comes a short run-up, shown as GO!, while the first arrows travel up from the
 * bottom. Its length is the arrows' travel time, so nothing is on screen during the numbers.
 */
const leadInRef = { current: 900 }

/**
 * On a local build (127.0.0.1) every run's presses, judgements (and in circle mode the pointer
 * path) go to the dev server, which saves them next to the test data. Never sent anywhere else.
 */
function sendPlayLog(session: GameSession | CircleSession, song: SongMeta, chart: Chart, settings: Settings, engine: AudioEngine | null, renderer: PlayfieldRenderer | null, quit = false): void {
  if (!['127.0.0.1', 'localhost'].includes(window.location.hostname)) return
  const circles = session instanceof CircleSession
  const body = {
    at: new Date().toISOString(),
    mode: circles ? 'circles' : 'arrows',
    quit,
    song: song.title,
    difficulty: chart.difficulty,
    bpms: chart.timing.bpms,
    offset: chart.timing.offset,
    windows: session.windows,
    audioOffsetMs: settings.audioOffsetMs,
    holdMode: settings.holdMode,
    longArrows: settings.longArrows,
    outputLatencyMs: engine ? Math.round(engine.outputLatency * 1000) : null,
    screen: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    touch: window.matchMedia('(pointer: coarse)').matches,
    frames: renderer?.frameStats() ?? null,
    ...(circles
      ? {
          radius: session.map.radius,
          preemptMs: session.map.preemptMs,
          clicks: session.clickStats,
          objects: session.map.objects.map((o) => ({ id: o.id, t: Math.round(o.time * 1000), end: Math.round(o.endTime * 1000), x: Math.round(o.x), y: Math.round(o.y), kind: o.kind, number: o.number })),
        }
      : {
          notes: session.chart.notes.map((n) => ({ id: n.id, t: Math.round(n.time * 1000), lane: n.lane, kind: n.kind, beat: n.beat, ...(n.duration ? { dur: Math.round(n.duration * 1000) } : {}) })),
        }),
    ...session.log,
  }
  void fetch('./__playlog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => undefined)
}

export function GameScreen({
  song,
  chart: sourceChart,
  circleRhythm,
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
  const sessionRef = useRef<GameSession | CircleSession | null>(null)
  const routerRef = useRef<InputRouter | null>(null)
  const detachTouchRef = useRef<(() => void) | null>(null)
  const rafRef = useRef(0)
  const finishedRef = useRef(false)
  const failedRef = useRef(false)
  const runCompleteRef = useRef(false)
  /** The audio window has finished playing; the judge clock runs on until the last window closes. */
  const audioEndedRef = useRef(false)
  const finishRunRef = useRef<() => void>(() => undefined)
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const pausedRef = useRef(false)
  const judgingRef = useRef(false)
  const countdownStartRef = useRef(0)
  const countdownPausedAtRef = useRef<number | null>(null)
  const engagingRef = useRef(false)
  const resumeAtRef = useRef<number | null>(null)
  const goAtRef = useRef<number | null>(null)
  // A pause the player did not choose (tab-out, a portal overlay, a phone call, Back) keeps held
  // long arrows alive: a lane let go meanwhile is judged when the music comes back, unless the
  // player is holding it again by then.
  const autoPausedRef = useRef(false)
  const deferredReleaseRef = useRef(new Set<0 | 1 | 2 | 3>())
  const armedTimerRef = useRef(0)
  const resultTimersRef = useRef<number[]>([])
  const settingsRef = useRef(settings)
  const autoPlayRef = useRef(autoPlay)
  const onFinishRef = useRef(onFinish)

  const [paused, setPaused] = useState(false)
  const [crashed, setCrashed] = useState(false)
  const [armed, setArmed] = useState<'restart' | 'quit' | null>(null)
  const armedRef = useRef<'restart' | 'quit' | null>(null)
  // The mode is fixed for the run; changing it in Settings applies to the next one.
  const [circleMode] = useState(() => settings.playMode === 'circles')
  const [circleSpeed] = useState(() => song.scrollSpeed ?? settings.scrollSpeed)
  const circleMap = useMemo(() => {
    if (!circleMode) return null
    const placed = placeCircles(sourceChart, circleRhythm ?? sourceChart)
    const preemptMs = approachForSpeed(placed.preemptMs, circleSpeed)
    return { ...placed, preemptMs, fadeInMs: (preemptMs * 2) / 3 }
  }, [circleMode, sourceChart, circleRhythm, circleSpeed])
  const [hud, setHud] = useState({ score: 0, combo: 0, accuracy: 1, judged: 0 })
  // Long arrows off: every hold plays as a plain tap at its start. Arrows a hand edit left in a
  // removed part, or outside the window, never play: they are left out of the run.
  const chart = useMemo(() => {
    const plan = planForMeta(song)
    const playable = sourceChart.notes.filter((note) => note.time >= plan.windowStart - 1e-3 && note.time <= plan.windowEnd + 1e-3 && !isCut(plan, note.time))
    const notes = settings.longArrows
      ? playable
      : playable.map((note) => {
          if (note.kind !== 'hold') return note
          const tap = { ...note, kind: 'tap' as const }
          delete tap.duration
          return tap
        })
    return notes.length === sourceChart.notes.length && settings.longArrows ? sourceChart : { ...sourceChart, notes }
  }, [sourceChart, settings.longArrows, song])
  // Touch devices have no keyboard: the hint should teach the gesture that actually works.
  const [touchOnly] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)

  // Every settings update rebuilds `customWindows`, so the memo keys on its values. A new object
  // here would rebuild the whole run (the volume slider in the pause menu used to do that).
  const customWindowsKey = JSON.stringify(settings.customWindows)
  const windows = useMemo(
    // Circles use osu!'s own windows; arrows use the chosen preset.
    () => (circleMode ? circleWindows(chart.difficulty) : judgmentWindows(settings.windowPreset, settings.customWindows, settings.timing === 'phone')),
    // customWindowsKey stands in for the object so an equal copy doesn't rebuild the windows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.windowPreset, customWindowsKey, chart.difficulty, settings.timing, circleMode],
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

  const pause = useCallback((automatic = false) => {
    if (finishedRef.current || pausedRef.current) return
    if (automatic) autoPausedRef.current = true
    resumeAtRef.current = null
    // Every note is already judged and only the outro is playing: Esc (or a hidden tab) means
    // "I'm done", so the run is saved and the results open instead of a pause menu.
    if (runCompleteRef.current && !failedRef.current) {
      finishRunRef.current()
      return
    }
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
    window.clearTimeout(armedTimerRef.current)
    armedRef.current = null
    setArmed(null)
    if (countdownPausedAtRef.current !== null) {
      countdownStartRef.current += performance.now() - countdownPausedAtRef.current
      countdownPausedAtRef.current = null
    }
    // Inside the click: the one moment a browser always lets a suspended context start again.
    void resumeAudioContext()
    pausedRef.current = false
    setPaused(false)
    // The music comes back after a 3-2-1 (the loop starts it). Before the song starts there is
    // nothing to run up to: the countdown itself carries on.
    if (engineRef.current) resumeAtRef.current = performance.now() + RESUME_RUNUP_MS
    else judgingRef.current = true
  }, [])

  const togglePause = useCallback(() => {
    if (pausedRef.current) resume()
    else pause(false)
  }, [pause, resume])

  const finishRun = useCallback(() => {
    if (finishedRef.current) return
    finishedRef.current = true
    const session = sessionRef.current
    if (!session) return
    judgingRef.current = false
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
      droppedHolds: session instanceof CircleSession ? session.brokenSliders : state.droppedHolds,
      objects: session.totalNotes,
      chartVersion: `${sourceChart.generator.version}:${sourceChart.generator.seed}${sourceChart.edited ? ':edited' : ''}`,
      autoPlay: session.isAutoPlay,
      rules: runRulesKey(settingsRef.current, session instanceof CircleSession ? 'circles' : 'arrows'),
      ...(session instanceof CircleSession ? { mode: 'circles' as const, clicks: session.clickStats } : {}),
    }
    if (!session.isAutoPlay) sendPlayLog(session, song, chart, settingsRef.current, engineRef.current, rendererRef.current)
    // Let the outro breathe: fade the music instead of cutting it the instant the last arrow is
    // judged, then switch to results after the fade has finished. The playfield stays visible (no
    // "loading" overlay) so the ending is not hidden.
    engineRef.current?.fadeOut(failed ? 0.3 : 1.1)
    resultTimersRef.current.push(
      window.setTimeout(() => engineRef.current?.pause(), failed ? 320 : 1150),
      window.setTimeout(() => onFinishRef.current(results), failed ? 750 : 1900),
    )
    // Reads the rest through refs and the run's own snapshot; only a new chart or song rebuilds it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart.difficulty, chart.id, song.id])
  finishRunRef.current = finishRun

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
    audioEndedRef.current = false
    pausedRef.current = false
    judgingRef.current = false
    engagingRef.current = false
    countdownPausedAtRef.current = null
    resumeAtRef.current = null
    goAtRef.current = null
    autoPausedRef.current = false
    deferredReleaseRef.current.clear()
    window.clearTimeout(armedTimerRef.current)
    armedRef.current = null
    setArmed(null)
    session.reset()
    // Re-run the countdown instead of jumping straight into the first notes; an instant restart
    // used to drop the opening arrows on the receptors with no time to read them.
    countdownStartRef.current = performance.now()
    setPaused(false)
    setHud({ score: 0, combo: 0, accuracy: 1, judged: 0 })
    rendererRef.current?.setChart(buffer.duration, chart)
  }, [buffer.duration, chart])

  // Restart and Quit throw the run away, so each needs a second press within a moment.
  const disarm = useCallback(() => {
    window.clearTimeout(armedTimerRef.current)
    armedRef.current = null
    setArmed(null)
  }, [])
  const confirmThen = useCallback((kind: 'restart' | 'quit', action: () => void) => {
    if (armedRef.current === kind) {
      disarm()
      action()
      return
    }
    window.clearTimeout(armedTimerRef.current)
    armedRef.current = kind
    setArmed(kind)
    armedTimerRef.current = window.setTimeout(disarm, CONFIRM_MS)
  }, [disarm])
  const quit = useCallback(() => {
    const session = sessionRef.current
    // A run quit halfway is often the one worth reading: log what was played.
    if (session && !session.isAutoPlay && !finishedRef.current) sendPlayLog(session, song, chart, settingsRef.current, engineRef.current, rendererRef.current, true)
    onExitRef.current()
  }, [chart, song])

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
    deferredReleaseRef.current.delete(lane)
    if (!session || !engine || !judgingRef.current || session.isAutoPlay) return
    const now = performance.now()
    const judgeMs = engine.judgeTime * 1000
    if (session instanceof CircleSession) {
      const at = session.pointerPosition
      session.press(at.x, at.y, compensateInputLatency(eventTimeMs, judgeMs, now))
      return
    }
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
    if (session instanceof CircleSession) return
    if (autoPausedRef.current) {
      deferredReleaseRef.current.add(lane)
      return
    }
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
      scrollSpeed: song.scrollSpeed ?? settingsRef.current.scrollSpeed,
      noteScale: settingsRef.current.noteScale,
      laneStyle: settingsRef.current.laneStyle,
      noteShape: settingsRef.current.noteShape,
      scrollDirection: settingsRef.current.scrollDirection,
      theme: settingsRef.current.theme,
      arrowColors: settingsRef.current.arrowColors,
      holdEndArrow: settingsRef.current.holdMode !== 'hold',
      progressStyle: settingsRef.current.progressStyle,
      columnColors: settingsRef.current.columnColors,
      reducedMotion: settingsRef.current.reducedMotion,
      circlePath: settingsRef.current.circlePath,
    })
    rendererRef.current = renderer
    renderer.setCircles(circleMap)
    renderer.setChart(buffer.duration, chart)
    renderer.setPlan(playbackPlan)
    renderer.resize()
    const observer = new ResizeObserver(() => renderer.resize())
    observer.observe(canvas)

    // Rectangles: a tap counts for as long as the rectangle overlaps its target.
    const catchMs = circleMap ? 0 : renderer.tileCatchMs()
    const runWindows = catchMs > windows.good ? { ...windows, good: catchMs, missAfter: Math.max(windows.missAfter, catchMs) } : windows
    const session: GameSession | CircleSession = circleMap
      ? new CircleSession({
          chart: sourceChart,
          map: circleMap,
          windows: runWindows,
          autoPlay: autoPlayRef.current,
          tailMs: 900,
          hitSlack: window.matchMedia('(pointer: coarse)').matches ? TOUCH_HIT_SLACK : HIT_SLACK,
          onJudgment: (event) => {
            renderer.notify(event, 0)
          },
          onIgnoredPress: (_reason, object, at) => renderer.ignoredPress(object, at),
          onComplete: () => {
            runCompleteRef.current = true
            if (failedRef.current) finishRun()
          },
        })
      : new GameSession({
          chart,
          windows: runWindows,
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
    // Wake the audio device now, during the countdown. Starting it on GO cost a visible hitch
    // (creating and resuming an AudioContext can block for a few hundred milliseconds on Windows),
    // and its latency estimate is needed to line the countdown up with the song.
    let preRollShiftMs = arrowOffsetMs(settingsRef.current.audioOffsetMs)
    void resumeAudioContext()
      .then(() => {
        preRollShiftMs = estimateOutputLatency(getAudioContext()) * 1000 + arrowOffsetMs(settingsRef.current.audioOffsetMs)
      })
      .catch(() => undefined)

    const engage = async (): Promise<void> => {
      await resumeAudioContext()
      if (disposed) return
      const engine = new AudioEngine(getAudioContext(), buffer, {
        volume: settingsRef.current.volume,
        offsetMs: arrowOffsetMs(settingsRef.current.audioOffsetMs),
        // The run ends at the window end, not the file end: a trimmed tail must not score misses.
        // The song is over at this point, so any arrow that was never reached is a miss — the
        // failure path is different: it stops where the rule was met and leaves the rest unplayed.
        // The audio has been rendered to the end, but the player hears it a little later and the
        // last notes and hold tails still have their windows open: the loop finishes the run once
        // the judge clock is past the window end (see below).
        onEnded: () => {
          audioEndedRef.current = true
        },
      })
      engineRef.current = engine
      engine.play(playPlan.windowStart, undefined, playbackPlan)
      judgingRef.current = true
    }

    // Phones run at 60 frames a second at most: a 120 Hz screen would double the work for nothing.
    const frameStep = window.matchMedia('(pointer: coarse)').matches ? 1000 / 60 : 0
    let nextFrameAt = 0
    // A frame that throws (a lost canvas, a broken imported chart) would end the loop with a
    // frozen picture and the song still playing: stop everything and say so instead.
    const crash = (error: unknown): void => {
      if (disposed) return
      console.error(error)
      cancelAnimationFrame(rafRef.current)
      engineRef.current?.pause()
      judgingRef.current = false
      pausedRef.current = true
      finishedRef.current = true
      setCrashed(true)
    }
    const loop = (now: number = performance.now()): void => {
      try {
        frame(now)
      } catch (error) {
        crash(error)
      }
    }
    const frame = (now: number): void => {
      if (disposed) return
      if (frameStep > 0) {
        if (now < nextFrameAt - 1) {
          rafRef.current = requestAnimationFrame(loop)
          return
        }
        nextFrameAt = Math.max(nextFrameAt + frameStep, now)
      }
      const activeSession = sessionRef.current
      const engine = engineRef.current
      if (!activeSession || !engine) {
        // Countdown phase: draw *before* the song starts, so the playfield is empty and the first
        // arrows rise from the bottom as the countdown reaches zero. The clock counts down to
        // the start of the playable window, not to 0: a trimmed song starts later in the file,
        // and counting to 0 made its first arrows pop up mid-screen on GO.
        leadInRef.current = renderer.leadInMs()
        const remaining = countdownRemaining()
        // The countdown runs on the same clock the song will: shifted by the device latency and the
        // player's timing correction, so nothing jumps when the music starts.
        renderer.render(activeSession ?? session, playPlan.windowStart * 1000 - remaining - preRollShiftMs, {
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
          engage().catch(crash)
        }
        rafRef.current = requestAnimationFrame(loop)
        return
      }
      // One clock for everything: the judged time (what the player hears, minus device latency and
      // their calibration) also positions the notes, so a note on the receptor is exactly delta 0.
      // StepMania's global offset shifts the chart against the audio the same way.
      const resumeAt = resumeAtRef.current
      if (resumeAt !== null && !pausedRef.current && now >= resumeAt) {
        resumeAtRef.current = null
        goAtRef.current = now
        engine.resume()
        judgingRef.current = true
        if (autoPausedRef.current) {
          autoPausedRef.current = false
          const at = engine.judgeTime * 1000
          for (const lane of deferredReleaseRef.current) if (!activeSession.isAutoPlay && !(activeSession instanceof CircleSession)) activeSession.releaseLane(lane, at)
          deferredReleaseRef.current.clear()
        }
      }
      const runUpMs = resumeAtRef.current !== null ? resumeAtRef.current - now : goAtRef.current !== null && now - goAtRef.current < 700 ? goAtRef.current - now : null
      const judgeMs = engine.judgeTime * 1000
      activeSession.update(judgeMs)
      const state = activeSession.scoreState
      renderer.render(activeSession, Math.max(0, judgeMs), {
        score: state.score,
        combo: state.combo,
        accuracy: state.accuracy,
        progress: engine.planDuration > 0 ? Math.min(1, Math.max(0, engine.planTime / engine.planDuration)) : 0,
        countdownMs: runUpMs,
        paused: false,
        autoPlay: activeSession.isAutoPlay,
        showStats: settingsRef.current.showStats,
        title: song.title,
        subtitle: DIFFICULTY_LABEL[chart.difficulty].toUpperCase(),
        subtitleColor: DIFFICULTY_COLOR[chart.difficulty],
      })
      if (!failedRef.current && !runCompleteRef.current && !autoPlayRef.current && checkFail(settingsRef.current.failRule, state)) {
        failedRef.current = true
        sfxFail()
        activeSession.forfeit(judgeMs)
      }
      // The audio is over: once the judge clock is past the window end plus the widest window
      // (a release in let-go mode is 1.5x), anything never reached is a miss and the run ends.
      if (audioEndedRef.current && !finishedRef.current && !failedRef.current) {
        const closeMs = playPlan.windowEnd * 1000 + activeSession.windows.missAfter * 1.5 + 50
        if (judgeMs >= closeMs) {
          if (!activeSession.isFinished) activeSession.forfeit(judgeMs)
          finishRun()
        }
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

    // Circle mode: the mouse or a finger aims; a button, Z / X, any lane key or the finger itself presses.
    const held = new Set<string>()
    const judgeAt = (eventTimeMs: number): number | null => {
      const engine = engineRef.current
      if (!engine || !judgingRef.current) return null
      return compensateInputLatency(eventTimeMs, engine.judgeTime * 1000, performance.now())
    }
    // A slider follows the finger that started it: a second finger tapping the next circles must
    // not move the ball's pointer away.
    let followId: number | null = null
    const lastAt = new Map<number, { x: number; y: number }>()
    const aim = (event: PointerEvent): { x: number; y: number } | null => {
      const rect = canvas.getBoundingClientRect()
      const sx = event.clientX - rect.left
      const sy = event.clientY - rect.top
      rendererRef.current?.setPointer(sx, sy, event.pointerType !== 'touch')
      const field = rendererRef.current?.toField(sx, sy)
      if (!field || !(session instanceof CircleSession)) return field ?? null
      lastAt.set(event.pointerId, field)
      if (!session.activeSlider) followId = null
      if (followId === null || followId === event.pointerId) session.move(field.x, field.y)
      return field
    }
    const letGo = (key: string, eventTimeMs: number): void => {
      if (!held.delete(key) || held.size > 0 || !(session instanceof CircleSession)) return
      session.release(judgeAt(eventTimeMs) ?? 0)
    }
    const onPointerMove = (event: PointerEvent): void => {
      aim(event)
    }
    const onPointerDown = (event: PointerEvent): void => {
      const field = aim(event)
      if (!field || !(session instanceof CircleSession) || finishedRef.current || pausedRef.current) return
      event.preventDefault()
      held.add(`p${event.pointerId}:${event.button}`)
      const at = judgeAt(event.timeStamp)
      if (at === null || session.isAutoPlay) return
      const hit = session.press(field.x, field.y, at)
      if (hit?.object.kind === 'slider' && session.activeSlider === hit.object) followId = event.pointerId
      else if (followId !== null && followId !== event.pointerId) {
        const back = lastAt.get(followId)
        if (back) session.move(back.x, back.y)
      }
    }
    const onPointerUp = (event: PointerEvent): void => {
      aim(event)
      lastAt.delete(event.pointerId)
      letGo(`p${event.pointerId}:${event.button}`, event.timeStamp)
    }
    const onPointerCancel = (event: PointerEvent): void => {
      for (const key of [...held]) if (key.startsWith(`p${event.pointerId}:`)) letGo(key, event.timeStamp)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.code !== 'KeyZ' && event.code !== 'KeyX') return
      if (event.type === 'keydown') {
        if (event.repeat || finishedRef.current || pausedRef.current) return
        held.add(event.code)
        pressLane(0, event.timeStamp)
      } else {
        letGo(event.code, event.timeStamp)
      }
    }
    // A right click on the playfield must not open the browser menu: that blurs the page and pauses.
    const noMenu = (event: Event): void => event.preventDefault()
    canvas.addEventListener('contextmenu', noMenu)
    if (circleMap) {
      canvas.addEventListener('pointermove', onPointerMove)
      canvas.addEventListener('pointerdown', onPointerDown)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerCancel)
      window.addEventListener('keydown', onKey)
      window.addEventListener('keyup', onKey)
    }

    routerRef.current = new InputRouter(
      {
        onLaneDown: (lane, eventTimeMs) => {
          if (circleMap) held.add(`k${lane}`)
          pressLane(lane, eventTimeMs)
        },
        onLaneUp: (lane, eventTimeMs) => {
          if (circleMap) letGo(`k${lane}`, eventTimeMs)
          releaseLane(lane, eventTimeMs)
        },
        onLaneStillHeld: (lane) => deferredReleaseRef.current.delete(lane),
        onPause: () => togglePause(),
        // The router lets go of every held key when focus goes; pause first, so held long arrows
        // wait for the run to come back instead of being judged as let go.
        onFocusLost: (type) => {
          if (type === 'visibilitychange' && document.visibilityState !== 'hidden') return
          if (engineRef.current?.isPlaying || resumeAtRef.current !== null) pause(true)
        },
        onRestart: () => {
          if (!pausedRef.current) pause(false)
          confirmThen('restart', restart)
        },
        onFullscreen: () => void toggleFullscreen(),
      },
      {
        keyMap: settingsRef.current.keyMap,
        controls: settingsRef.current.controls,
        enabled: () => !finishedRef.current && !pausedRef.current,
        canRestart: () => !finishedRef.current,
      },
    )

    detachTouchRef.current = circleMap
      ? null
      : attachTouchLanes(canvas, {
          onLaneDown: (lane, eventTimeMs) => pressLane(lane, eventTimeMs),
          onLaneUp: (lane, eventTimeMs) => releaseLane(lane, eventTimeMs),
          laneAt: (x) => rendererRef.current?.laneAt(x) ?? null,
        })

    // Audio must never keep playing in a background tab: hiding the tab pauses the run.
    // Phone Back during a run pauses it; Back again from the pause menu leaves to song setup.
    const onBack = (): void => {
      if (finishedRef.current) return
      if (pausedRef.current) onExitRef.current()
      else pause(true)
    }
    window.addEventListener(BACK_EVENT, onBack)
    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden') return
      if (engineRef.current?.isPlaying || resumeAtRef.current !== null || (!engineRef.current && !engagingRef.current)) pause(true)
    }
    // Leaving during the countdown pauses too; otherwise the song starts while nobody is looking.
    const onBlur = (): void => {
      if (engineRef.current?.isPlaying || resumeAtRef.current !== null || (!engineRef.current && !engagingRef.current)) pause(true)
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlur)
    // A phone call, Siri or a Bluetooth switch can stop the audio clock under a running song: the
    // picture would freeze with no menu. Pause instead, so Resume restarts the audio.
    const audioContext = getAudioContext()
    const onAudioState = (): void => {
      if (audioContext.state !== 'running' && engineRef.current?.isPlaying && !pausedRef.current) pause(true)
    }
    audioContext.addEventListener('statechange', onAudioState)

    return () => {
      disposed = true
      for (const timer of resultTimersRef.current) window.clearTimeout(timer)
      resultTimersRef.current = []
      observer.disconnect()
      cancelAnimationFrame(rafRef.current)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener(BACK_EVENT, onBack)
      audioContext.removeEventListener('statechange', onAudioState)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('contextmenu', noMenu)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      if (root && document.fullscreenElement === root) void document.exitFullscreen().catch(() => undefined)
      detachTouchRef.current?.()
      detachTouchRef.current = null
      routerRef.current?.dispose()
      routerRef.current = null
      engineRef.current?.dispose()
      engineRef.current = null
      sessionRef.current = null
      renderer.dispose()
      rendererRef.current = null
    }
  }, [buffer, chart, circleMap, confirmThen, finishRun, pause, playPlan, playbackPlan, pressLane, releaseLane, restart, song.scrollSpeed, song.title, sourceChart, toggleFullscreen, togglePause, windows])

  /* --------------------------------------------------------- live settings */

  useEffect(() => {
    engineRef.current?.setVolume(settings.volume)
    engineRef.current?.setOutputOffsetMs(arrowOffsetMs(settings.audioOffsetMs))
    rendererRef.current?.setSettings({
      scrollSpeed: song.scrollSpeed ?? settings.scrollSpeed,
      noteScale: settings.noteScale,
      laneStyle: settings.laneStyle,
      noteShape: settings.noteShape,
      scrollDirection: settings.scrollDirection,
      theme: settings.theme,
      arrowColors: settings.arrowColors,
      holdEndArrow: settings.holdMode !== 'hold',
      progressStyle: settings.progressStyle,
      columnColors: settings.columnColors,
      reducedMotion: settings.reducedMotion,
      circlePath: settings.circlePath,
    })
  }, [settings, song.scrollSpeed])

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
        className={circleMode ? 'game-canvas circles' : 'game-canvas'}
        ref={canvasRef}
        role="img"
        aria-label={circleMode ? 'Rhythm game field with circles to hit' : 'Rhythm game playfield with four arrow lanes'}
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
          <Icon name="fullscreen" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={togglePause}
          title={`Pause (${describeKey(settings.controls.pause[0])})`}
        >
          <Icon name="pause" />
        </Button>
      </div>

      {crashed && (
        <div className="game-overlay">
          <div className="panel">
            <h2>The run stopped</h2>
            <p className="muted small mt-8">Something went wrong while drawing the song. Your songs and scores are safe.</p>
            <div className="col gap-12 mt-16">
              <Button variant="primary" onClick={onExit}>
                Back to song setup
              </Button>
            </div>
          </div>
        </div>
      )}

      {paused && !crashed && (
        <div className="game-overlay">
          <div className="panel">
            <h2>Paused</h2>
            <p className="muted small mt-8">
              {song.title} - {DIFFICULTY_LABEL[chart.difficulty]}
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
              <Button onClick={() => confirmThen('restart', restart)}>
                {armed === 'restart' ? `Press again to restart` : `Restart (${describeKey(settings.controls.restart[0])})`}
              </Button>
              <Button variant="ghost" onClick={() => confirmThen('quit', quit)}>
                {armed === 'quit' ? 'Press again to quit' : 'Quit to song setup'}
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
          ? circleMode
            ? 'Auto-play: watch the circles play themselves'
            : 'Auto-play: watch the arrows play themselves'
          : circleMode
            ? touchOnly
              ? 'Tap each circle as its ring closes, slide along the long ones'
              : `Aim with the mouse, click or press Z / X as each ring closes - ${describeKey(settings.controls.pause[0])} pause`
            : touchOnly
            ? 'Tap each column as its note reaches the target'
            : `${laneKeys(0)} or ${laneKeys(1)} to hit - ${describeKey(settings.controls.pause[0])} pause - ${describeKey(settings.controls.restart[0])} restart`}
      </div>
    </div>
  )
}
