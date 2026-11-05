import React, { useEffect, useRef, useSyncExternalStore } from 'react'
import type { Chart, ChartNote, Lane } from '../core/types'
import { GameSession } from '../game/session'
import { windowsForDifficulty } from '../game/judgment'
import { PlayfieldRenderer } from '../render/renderer'
import { settingsStore } from '../store/settings'

const PREVIEW_BPM = 128
const LOOP_BEATS = 16
/**
 * How far off the demo player hits each note, in ms (null = no tap, a miss), so the preview shows
 * the whole range of judgements instead of a wall of Marvelous.
 */
const HIT_OFFSETS: (number | null)[] = [
  0, 26, -55, 5, 0, -8, 72, null, 0, 30, -75, 0, 50, -12, 4, 0, -28, 58, 0, null, -60, 7, 0,
]

/**
 * The home page demo: the real playfield renderer playing a short looping chart on auto-play, so it
 * always looks exactly like the game. Column colours are shuffled on every visit.
 */
export function PlayfieldPreview(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get)
  const rendererRef = useRef<PlayfieldRenderer | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const chart = previewChart()
    const renderer = new PlayfieldRenderer(
      canvas,
      { ...previewSettings(settingsStore.get()), arrowColors: 'random' },
      { preview: true },
    )
    rendererRef.current = renderer
    renderer.setChart(chart.notes.length, chart)
    renderer.resize()
    const observer = new ResizeObserver(() => renderer.resize())
    observer.observe(canvas)

    const session = new GameSession({
      chart,
      windows: windowsForDifficulty('standard', 'normal'),
      holdMode: 'hold',
      onJudgment: (event) => renderer.notify(event, session.scoreState.combo),
      onHoldComplete: (lane) => renderer.holdComplete(lane),
    })
    const loopMs = (LOOP_BEATS * 60_000) / PREVIEW_BPM
    const leadMs = 900
    const started = performance.now()
    let lastLoop = 0
    let frame = 0
    let next = 0
    const releaseAt: (number | null)[] = [null, null, null, null]
    const tick = (): void => {
      const elapsed = performance.now() - started
      const loop = Math.floor(elapsed / loopMs)
      if (loop !== lastLoop) {
        lastLoop = loop
        next = 0
        session.reset()
      }
      const songMs = (elapsed % loopMs) - leadMs
      // A scripted player: taps each note at its planned offset and lets go after the hold ends.
      while (next < chart.notes.length) {
        const note = chart.notes[next]
        const offset = HIT_OFFSETS[next % HIT_OFFSETS.length]
        const at = note.time * 1000 + (offset ?? 0)
        if (at > songMs) break
        next++
        if (offset === null) continue
        // Tapped where it really was: early and late hits leave the note short of or past the target.
        session.handleTap(note.lane, at)
        renderer.press(note.lane)
        releaseAt[note.lane] = (note.time + (note.duration ?? 0)) * 1000 + 90
      }
      for (let lane = 0; lane < 4; lane++) {
        const at = releaseAt[lane]
        if (at !== null && songMs >= at) {
          releaseAt[lane] = null
          session.releaseLane(lane as Lane, at)
          renderer.release(lane as Lane)
        }
      }
      session.update(songMs)
      const state = session.scoreState
      renderer.render(session, songMs, {
        score: state.score,
        combo: state.combo,
        accuracy: state.accuracy,
        progress: 0,
        countdownMs: null,
        paused: false,
        autoPlay: false,
        showStats: false,
      })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      rendererRef.current = null
    }
  }, [])

  // Arrow skin, size, theme and motion follow Settings live, like the real game does.
  useEffect(() => {
    rendererRef.current?.setSettings(previewSettings(settings))
  }, [settings])

  return <canvas ref={canvasRef} className="hero-preview-canvas" aria-hidden="true" />
}

function previewSettings(settings: ReturnType<typeof settingsStore.get>) {
  return {
    // A touch quicker than the player's own speed so the short demo stays lively.
    scrollSpeed: Math.min(10, settings.scrollSpeed + 2),
    noteScale: settings.noteScale,
    laneStyle: settings.laneStyle,
    noteShape: settings.noteShape,
    scrollDirection: settings.scrollDirection,
    theme: settings.theme,
    columnColors: settings.columnColors,
    holdEndArrow: settings.holdMode !== 'hold',
    reducedMotion: settings.reducedMotion,
  }
}

/** A 16-beat loop: a little stream, a jump, and one hold, so every effect shows up. */
function previewChart(): Chart {
  const pattern: [number, Lane, number?][] = [
    [0, 0], [1, 3], [2, 1], [2.5, 2], [3, 0], [4, 2, 1.5], [4, 0], [5, 3],
    [6, 1], [6.5, 3], [7, 0], [8, 1], [8, 2], [9, 3], [9.5, 0], [10, 2],
    [11, 1, 1], [12, 3], [12.5, 2], [13, 0], [14, 3], [14.5, 1], [15, 2],
  ]
  const secondsPerBeat = 60 / PREVIEW_BPM
  const notes: ChartNote[] = pattern.map(([beat, lane, holdBeats], index) => ({
    id: `preview-${index}`,
    lane,
    time: beat * secondsPerBeat,
    beat,
    step: Math.round(beat * 4),
    kind: holdBeats ? 'hold' : 'tap',
    strength: 1,
    ...(holdBeats ? { duration: holdBeats * secondsPerBeat } : {}),
  }))
  return {
    schema: 1,
    id: 'preview',
    songId: 'preview',
    difficulty: 'normal',
    title: '',
    timing: { offset: 0, bpms: [{ beat: 0, bpm: PREVIEW_BPM }] },
    stepsPerBeat: 4,
    notes,
    stats: { noteCount: notes.length } as Chart['stats'],
    generator: {} as Chart['generator'],
    edited: false,
    createdAt: 0,
    updatedAt: 0,
  }
}
