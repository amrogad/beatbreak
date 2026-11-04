/**
 * Chart editor.
 *
 * A 4-lane × time grid over the real audio: add notes, drag them, delete them, correct BPM/offset,
 * re-snap to the grid, play the result with a metronome, and export.
 *
 * Everything the editor produces is the same `Chart` shape the game plays, so what you hear in the
 * preview is exactly what the run will judge. `.sm` export goes through the strict exporter: if the
 * chart cannot be represented as a valid StepMania file, the editor says so instead of writing one.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Chart, ChartNote, Difficulty, Lane } from '../../core/types'
import { DIFFICULTIES, DIFFICULTY_COLOR, DIFFICULTY_LABEL, LANE_INFO } from '../../core/types'
import { AudioEngine, getAudioContext, resumeAudioContext } from '../../audio/engine'
import { TimingMap } from '../../chart/timing'
import { validatePlayability } from '../../chart/generate'
import { exportSm, parseChartFile, serializeChart } from '../../chart/serialize'
import { computeStats } from '../../chart/generate'
import { createId } from '../../core/rng'
import { runtime } from '../runtime'
import { saveChart } from '../../store/repository'
import { loadSongBundle } from '../../store/library'
import { planForMeta, toPlaybackPlan } from '../../core/edit'
import type { SongBundle } from '../../store/library'
import { Button, Chip, Panel, Select, Spinner, Stat, Toggle } from '../components'
import { hexToRgba } from '../../render/renderer'
import { formatClock, formatDuration } from '../format'

export interface EditorScreenProps {
  songId: string
  chartId: string
  onBack: () => void
  onToast: (message: string, tone?: 'info' | 'error' | 'success') => void
  onChartsChanged: (songId: string, charts: Chart[]) => void
}

const UNDO_LIMIT = 40

/** Undo restores the grid along with the notes, so a BPM or resolution change can be taken back. */
type UndoEntry = Pick<Chart, 'notes' | 'timing' | 'stepsPerBeat'>

export function EditorScreen({ songId, chartId, onBack, onToast, onChartsChanged }: EditorScreenProps): React.JSX.Element {
  const [bundle, setBundle] = useState<SongBundle | null>(() => runtime.get(songId) ?? null)
  const [chart, setChart] = useState<Chart | null>(null)
  const [dirty, setDirty] = useState(false)
  const [selection, setSelection] = useState<string | null>(null)
  const [camera, setCamera] = useState({ start: 0, span: 12 })
  const [playing, setPlaying] = useState(false)
  const [metronome, setMetronome] = useState(true)
  const [snap, setSnap] = useState(true)
  const [playhead, setPlayhead] = useState(0)
  const [smResult, setSmResult] = useState<{ ok: boolean; errors: string[]; warnings: string[] } | null>(null)
  const [importWarnings, setImportWarnings] = useState<string[] | null>(null)
  const [bpmDraft, setBpmDraft] = useState<string | null>(null)
  const [offsetDraft, setOffsetDraft] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const engineRef = useRef<AudioEngine | null>(null)
  const rafRef = useRef(0)
  const clickCursorRef = useRef(0)
  const undoRef = useRef<UndoEntry[]>([])
  const dragRef = useRef<{ noteId: string; grabTime: number; before: ChartNote[]; moved: boolean } | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const playheadRef = useRef(0)

  /* ------------------------------------------------------------------- load */

  useEffect(() => {
    if (bundle) return
    let cancelled = false
    loadSongBundle(songId)
      .then((loaded) => {
        if (cancelled || !loaded) return
        runtime.put(loaded)
        setBundle(loaded)
      })
      .catch((caught: unknown) => onToast(caught instanceof Error ? caught.message : String(caught), 'error'))
    return () => {
      cancelled = true
    }
  }, [bundle, onToast, songId])

  useEffect(() => {
    if (!bundle || chart) return
    const initial = bundle.charts.find((candidate) => candidate.id === chartId) ?? bundle.charts[0]
    if (initial) setChart(initial)
  }, [bundle, chart, chartId])

  const timing = useMemo(() => (chart ? new TimingMap(chart.timing) : TimingMap.single(120, 0)), [chart])
  const duration = bundle?.meta.duration ?? 0

  /* --------------------------------------------------------------- playback */

  const stopPlayback = useCallback(() => {
    const engine = engineRef.current
    engineRef.current = null
    if (engine) engine.dispose()
    cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    setPlaying(false)
  }, [])

  useEffect(() => stopPlayback, [stopPlayback])

  const togglePlayback = useCallback(async () => {
    if (!bundle?.buffer || !chart) return
    if (engineRef.current) {
      stopPlayback()
      return
    }
    await resumeAudioContext()
    const engine = new AudioEngine(getAudioContext(), bundle.buffer, {
      volume: 0.9,
      onEnded: () => stopPlayback(),
    })
    engineRef.current = engine
    // Audition through the same edit plan the game plays: previewing from inside a removed section
    // snaps forward and cuts splice instead of playing audio that will never be part of a run. A
    // playhead at (or past) the end starts again from the top.
    const plan = planForMeta(bundle.meta)
    const startAt = Math.max(0, Math.min(playheadRef.current, duration))
    const from = startAt >= plan.windowEnd - 0.05 ? plan.windowStart : Math.max(plan.windowStart, startAt)
    clickCursorRef.current = Math.ceil((from - timing.offset) / timing.secondsPerBeat(timing.timeToBeat(from)))
    engine.play(from, undefined, toPlaybackPlan(plan))
    setPlaying(true)
    const loop = (): void => {
      const active = engineRef.current
      if (!active) return
      const time = active.songTime
      playheadRef.current = time
      setPlayhead(time)
      if (metronome) {
        const beat = timing.timeToBeat(time)
        const spb = timing.secondsPerBeat(beat)
        let index = clickCursorRef.current
        let beatTime = timing.offset + index * spb
        while (beatTime < time + 0.02) {
          index++
          beatTime = timing.offset + index * spb
        }
        while (beatTime <= time + 0.35) {
          active.scheduleClickAt(beatTime, index % 4 === 0)
          index++
          beatTime = timing.offset + index * spb
        }
        clickCursorRef.current = index
      }
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
  }, [bundle, chart, duration, metronome, stopPlayback, timing])

  /* ------------------------------------------------------------------ edits */

  const pushUndo = useCallback((entry: UndoEntry) => {
    undoRef.current.push(entry)
    if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift()
  }, [])

  const commitNotes = useCallback(
    (notes: ChartNote[], options: { undo?: ChartNote[] } = {}) => {
      if (options.undo && chart) pushUndo({ notes: options.undo, timing: chart.timing, stepsPerBeat: chart.stepsPerBeat })
      setChart((current) => {
        if (!current) return current
        const sorted = [...notes].sort((a, b) => (a.time === b.time ? a.lane - b.lane : a.time - b.time))
        return { ...current, notes: sorted, stats: computeStats(sorted, duration), edited: true }
      })
      setDirty(true)
    },
    [chart, duration, pushUndo],
  )

  const undo = useCallback(() => {
    const previous = undoRef.current.pop()
    if (!previous || !chart) return
    setChart({ ...chart, ...previous, stats: computeStats(previous.notes, duration), edited: true })
    setBpmDraft(null)
    setOffsetDraft(null)
    setDirty(true)
  }, [chart, duration])

  /** Move the grid and re-snap every note onto it, as one undoable step. */
  const regrid = useCallback(
    (nextTiming: TimingMap, stepsPerBeat: number) => {
      if (!chart) return
      pushUndo({ notes: chart.notes, timing: chart.timing, stepsPerBeat: chart.stepsPerBeat })
      const notes = chart.notes.map((note) => {
        const time = nextTiming.snapTime(note.time, stepsPerBeat)
        return { ...note, time, beat: nextTiming.timeToBeat(time), step: nextTiming.timeToStep(time, stepsPerBeat) }
      })
      setChart({ ...chart, timing: nextTiming.toJSON(), stepsPerBeat, notes, stats: computeStats(notes, duration), edited: true })
      setDirty(true)
    },
    [chart, duration, pushUndo],
  )

  const applyBpmDraft = (): void => {
    if (bpmDraft === null) return
    const next = Number(bpmDraft)
    setBpmDraft(null)
    if (!chart || !Number.isFinite(next) || next < 30 || next > 320) return
    if (Math.abs(next - timing.primaryBpm) < 1e-9) return
    regrid(timing.withBpm(next), chart.stepsPerBeat)
  }

  const applyOffsetDraft = (): void => {
    if (offsetDraft === null) return
    const next = Number(offsetDraft) / 1000
    setOffsetDraft(null)
    if (!chart || offsetDraft.trim() === '' || !Number.isFinite(next)) return
    if (Math.abs(next - timing.offset) < 1e-6) return
    regrid(timing.withOffset(next), chart.stepsPerBeat)
  }

  const snapTime = useCallback(
    (time: number): number => (snap ? timing.snapTime(Math.max(0, time), chart?.stepsPerBeat ?? 4) : Math.max(0, time)),
    [chart?.stepsPerBeat, snap, timing],
  )

  const timeFromX = useCallback(
    (x: number, width: number): number => camera.start + (x / Math.max(1, width)) * camera.span,
    [camera.span, camera.start],
  )

  const xFromTime = useCallback(
    (time: number, width: number): number => ((time - camera.start) / camera.span) * width,
    [camera.span, camera.start],
  )

  const hitTest = useCallback(
    (time: number, lane: Lane): ChartNote | null => {
      if (!chart) return null
      const tolerance = camera.span * 0.012
      let best: ChartNote | null = null
      let bestDistance = Number.POSITIVE_INFINITY
      for (const note of chart.notes) {
        if (note.lane !== lane) continue
        const distance = Math.abs(note.time - time)
        if (distance <= tolerance && distance < bestDistance) {
          best = note
          bestDistance = distance
        }
      }
      return best
    },
    [camera.span, chart],
  )

  /* ----------------------------------------------------------------- canvas */

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap || !chart) return
    let raf = 0
    const draw = (): void => {
      const rect = wrap.getBoundingClientRect()
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2))
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(200, Math.round(rect.height))
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr)
        canvas.height = Math.round(height * dpr)
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#0e1114'
      ctx.fillRect(0, 0, width, height)

      const ruler = 22
      const laneH = (height - ruler) / 4

      // Lane rows
      for (let lane = 0; lane < 4; lane++) {
        const y = ruler + lane * laneH
        ctx.fillStyle = lane % 2 === 0 ? 'rgba(255,255,255,0.022)' : 'rgba(255,255,255,0.04)'
        ctx.fillRect(0, y, width, laneH)
        ctx.fillStyle = hexToRgba(LANE_INFO[lane].color, 0.75)
        ctx.font = '700 12px ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(`${LANE_INFO[lane].arrow} ${LANE_INFO[lane].label}`, 8, y + laneH / 2)
      }

      // Silent regions
      for (const region of bundle?.meta.analysis.silentRegions ?? []) {
        const x0 = xFromTime(region.start, width)
        const x1 = xFromTime(region.end, width)
        if (x1 < 0 || x0 > width) continue
        ctx.fillStyle = 'rgba(255,255,255,0.035)'
        ctx.fillRect(x0, ruler, Math.max(1, x1 - x0), height - ruler)
      }

      // Grid
      const spb = timing.secondsPerBeat(0)
      const stepsPerBeat = chart.stepsPerBeat
      const stepSeconds = spb / stepsPerBeat
      const firstStep = Math.floor(camera.start / stepSeconds) - 1
      const lastStep = Math.ceil((camera.start + camera.span) / stepSeconds) + 1
      for (let step = firstStep; step <= lastStep; step++) {
        const time = timing.stepToTime(step, stepsPerBeat)
        const x = xFromTime(time, width)
        if (x < -1 || x > width + 1) continue
        const isBar = step % (stepsPerBeat * 4) === 0
        const isBeat = step % stepsPerBeat === 0
        ctx.strokeStyle = isBar ? 'rgba(86,180,233,0.5)' : isBeat ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.07)'
        ctx.lineWidth = isBar ? 1.5 : 1
        ctx.beginPath()
        ctx.moveTo(x, isBar || isBeat ? 0 : ruler)
        ctx.lineTo(x, height)
        ctx.stroke()
      }

      // Ruler labels
      ctx.fillStyle = 'rgba(139, 150, 159, 0.9)'
      ctx.font = '11px ui-monospace, monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const labelEvery = Math.max(0.25, Math.round(camera.span / 12 * 4) / 4)
      const firstLabel = Math.ceil(camera.start / labelEvery) * labelEvery
      for (let time = firstLabel; time <= camera.start + camera.span; time += labelEvery) {
        const x = xFromTime(time, width)
        ctx.fillText(formatClock(time), x, 11)
      }

      // Notes
      const noteH = Math.min(laneH * 0.62, 26)
      const noteW = Math.max(7, Math.min(16, camera.span > 30 ? 8 : 14))
      for (const note of chart.notes) {
        const x = xFromTime(note.time, width)
        if (x < -20 || x > width + 20) continue
        const y = ruler + note.lane * laneH + (laneH - noteH) / 2
        const color = LANE_INFO[note.lane].color
        ctx.fillStyle = note.id === selection ? '#ffffff' : color
        ctx.strokeStyle = hexToRgba(color, 0.9)
        ctx.lineWidth = 1
        const radius = 4
        ctx.beginPath()
        ctx.moveTo(x - noteW / 2 + radius, y)
        ctx.arcTo(x + noteW / 2, y, x + noteW / 2, y + noteH, radius)
        ctx.arcTo(x + noteW / 2, y + noteH, x - noteW / 2, y + noteH, radius)
        ctx.arcTo(x - noteW / 2, y + noteH, x - noteW / 2, y, radius)
        ctx.arcTo(x - noteW / 2, y, x + noteW / 2, y, radius)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      }

      // Playhead
      const px = xFromTime(playhead, width)
      if (px >= 0 && px <= width) {
        ctx.strokeStyle = '#f0e442'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(px, 0)
        ctx.lineTo(px, height)
        ctx.stroke()
      }
    }
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [bundle?.meta.analysis.silentRegions, camera, chart, playhead, selection, timing, xFromTime])

  /* -------------------------------------------------------------- shortcuts */

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return
      if (event.code === 'Space') {
        event.preventDefault()
        void togglePlayback()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ') {
        event.preventDefault()
        undo()
        return
      }
      if (!chart) return
      if (event.code === 'Delete' || event.code === 'Backspace') {
        if (!selection) return
        event.preventDefault()
        const before = chart.notes
        commitNotes(
          before.filter((note) => note.id !== selection),
          { undo: before },
        )
        setSelection(null)
        return
      }
      const nudge: Record<string, { time?: number; lane?: number }> = {
        ArrowLeft: { time: -1 },
        ArrowRight: { time: 1 },
        ArrowUp: { lane: -1 },
        ArrowDown: { lane: 1 },
      }
      const action = nudge[event.code]
      if (action && selection) {
        event.preventDefault()
        const before = chart.notes
        const stepSeconds = timing.secondsPerBeat(0) / chart.stepsPerBeat
        commitNotes(
          before.map((note) => {
            if (note.id !== selection) return note
            const nextTime = Math.max(0, note.time + (action.time ?? 0) * stepSeconds)
            const nextLane = Math.max(0, Math.min(3, note.lane + (action.lane ?? 0))) as Lane
            return { ...note, time: nextTime, lane: nextLane, beat: timing.timeToBeat(nextTime), step: timing.timeToStep(nextTime, chart.stepsPerBeat) }
          }),
          { undo: before },
        )
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chart, commitNotes, selection, timing, togglePlayback, undo])

  /* ------------------------------------------------------------ persistence */

  const save = useCallback(async () => {
    if (!chart) return
    const playability = validatePlayability(chart, duration)
    if (!playability.ok) {
      onToast(`Saved, but ${playability.errors} playability error(s) remain. Check the report.`, 'info')
    }
    await saveChart(chart)
    setDirty(false)
    const charts = (bundle?.charts ?? []).map((candidate) => (candidate.id === chart.id ? chart : candidate))
    const updated = { ...(bundle as SongBundle), charts }
    runtime.put(updated)
    setBundle(updated)
    onChartsChanged(songId, charts)
    onToast('Chart saved.', 'success')
  }, [bundle, chart, duration, onChartsChanged, onToast, songId])

  const downloadText = (fileName: string, text: string): void => {
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    URL.revokeObjectURL(url)
  }

  const exportJson = useCallback(() => {
    if (!chart || !bundle) return
    const text = serializeChart(chart, {
      title: bundle.meta.title,
      artist: bundle.meta.artist,
      fileName: bundle.meta.fileName,
      duration: bundle.meta.duration,
    })
    downloadText(`${bundle.meta.title.replace(/[^\w\- ]+/g, '')}-${chart.difficulty}.pulsegrid.json`, text)
    onToast('Chart exported as JSON.', 'success')
  }, [bundle, chart, onToast])

  const exportStepMania = useCallback(() => {
    if (!chart || !bundle) return
    const result = exportSm(chart, {
      title: bundle.meta.title,
      artist: bundle.meta.artist,
      musicFileName: bundle.meta.fileName,
      rowsPerBeat: chart.stepsPerBeat,
    })
    setSmResult({ ok: result.ok, errors: result.errors, warnings: result.warnings })
    if (!result.ok) {
      onToast('This chart cannot be exported as a valid .sm file — see the issues below.', 'error')
      return
    }
    downloadText(`${bundle.meta.title.replace(/[^\w\- ]+/g, '')}-${chart.difficulty}.sm`, result.text)
    onToast('Exported a valid StepMania .sm file.', 'success')
  }, [bundle, chart, onToast])

  const importJson = useCallback(
    async (file: File) => {
      const text = await file.text()
      const parsed = parseChartFile(text)
      if (!parsed.ok) {
        setImportWarnings(null)
        onToast(`Import failed: ${parsed.error}`, 'error')
        return
      }
      if (!chart) return
      const incoming = parsed.chart
      const notes = [...incoming.notes].sort((a, b) => (a.time === b.time ? a.lane - b.lane : a.time - b.time))
      // The file's notes and grid replace this chart; it stays this song's chart at this difficulty.
      pushUndo({ notes: chart.notes, timing: chart.timing, stepsPerBeat: chart.stepsPerBeat })
      setChart({
        ...incoming,
        id: chart.id,
        songId,
        difficulty: chart.difficulty,
        title: bundle?.meta.title ?? incoming.title,
        notes,
        stats: computeStats(notes, duration),
        edited: true,
        updatedAt: Date.now(),
      })
      setDirty(true)
      setBpmDraft(null)
      setOffsetDraft(null)
      setImportWarnings(parsed.warnings)
      onToast(`Imported ${notes.length} notes from ${file.name}. Review, then save.`, 'success')
    },
    [bundle?.meta.title, chart, duration, onToast, pushUndo, songId],
  )

  /* ------------------------------------------------------------------ render */

  if (!bundle || !chart) {
    return (
      <div className="page narrow">
        <Panel title="Editor">
          <Spinner label={bundle ? 'Selecting chart…' : 'Loading song…'} />
          <div className="mt-16">
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
          </div>
        </Panel>
      </div>
    )
  }

  const playability = validatePlayability(chart, duration)
  const errors = playability.issues.filter((issue) => issue.severity === 'error')
  const warnings = playability.issues.filter((issue) => issue.severity === 'warning')

  return (
    <div className="page">
      <div className="row-between wrap gap-12">
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (dirty && !window.confirm('Leave the editor without saving your changes?')) return
              stopPlayback()
              onBack()
            }}
          >
            ← Back
          </Button>
          <h1 className="mt-8">{bundle.meta.title}</h1>
          <p className="muted small">
            Chart editor · {chart.notes.length} notes · {formatDuration(duration)} ·{' '}
            {dirty ? <span className="warn">unsaved changes</span> : <span className="good">saved</span>}
          </p>
        </div>
        <div className="row gap-8 wrap">
          <Button variant="primary" onClick={() => void save()} disabled={!dirty}>
            Save chart
          </Button>
          <Button onClick={exportJson}>Export JSON</Button>
          <Button onClick={exportStepMania}>Export .sm</Button>
          <Button onClick={() => importInputRef.current?.click()}>Import JSON</Button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void importJson(file)
            }}
          />
        </div>
      </div>

      <Panel>
        <div className="editor-toolbar">
          <div className="chips">
            {DIFFICULTIES.map((difficulty) => {
              const candidate = bundle.charts.find((c) => c.difficulty === difficulty)
              return (
                <button
                  key={difficulty}
                  type="button"
                  className="difficulty-chip"
                  disabled={!candidate}
                  style={{
                    borderColor: candidate?.difficulty === chart.difficulty ? DIFFICULTY_COLOR[difficulty] : undefined,
                    color: candidate?.difficulty === chart.difficulty ? DIFFICULTY_COLOR[difficulty] : undefined,
                  }}
                  onClick={() => {
                    if (dirty && !window.confirm('Discard unsaved changes and switch difficulty?')) return
                    if (!candidate) return
                    stopPlayback()
                    undoRef.current = []
                    setChart(candidate)
                    setSelection(null)
                    setDirty(false)
                    setSmResult(null)
                    setBpmDraft(null)
                    setOffsetDraft(null)
                  }}
                >
                  {DIFFICULTY_LABEL[difficulty]}
                </button>
              )
            })}
          </div>
          <div className="grow" />
          <Button size="sm" onClick={() => void togglePlayback()}>
            {playing ? '■ Stop' : '▶ Play'}
          </Button>
          <Button size="sm" variant="ghost" onClick={undo} disabled={undoRef.current.length === 0}>
            ↶ Undo
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (!selection) return
              const before = chart.notes
              commitNotes(
                before.filter((note) => note.id !== selection),
                { undo: before },
              )
              setSelection(null)
            }}
            disabled={!selection}
          >
            Delete selected
          </Button>
          <Toggle label="Snap to grid" checked={snap} onChange={setSnap} />
          <Toggle label="Metronome" checked={metronome} onChange={setMetronome} />
        </div>

        <div ref={wrapRef} className="editor-canvas-wrap mt-12">
          <canvas
            ref={canvasRef}
            className="editor-canvas"
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              const x = event.clientX - rect.left
              const y = event.clientY - rect.top
              const time = timeFromX(x, rect.width)
              const lane = Math.max(0, Math.min(3, Math.floor(((y - 22) / Math.max(1, rect.height - 22)) * 4))) as Lane
              if (y < 22) {
                // The time ruler moves the playhead; Play starts from there.
                if (playing) stopPlayback()
                const seek = Math.max(0, Math.min(duration, time))
                playheadRef.current = seek
                setPlayhead(seek)
                return
              }
              const hit = hitTest(time, lane)
              if (event.button === 2) {
                if (!hit) return
                const before = chart.notes
                commitNotes(
                  before.filter((note) => note.id !== hit.id),
                  { undo: before },
                )
                if (selection === hit.id) setSelection(null)
                return
              }
              if (hit) {
                setSelection(hit.id)
                dragRef.current = { noteId: hit.id, grabTime: time - hit.time, before: chart.notes, moved: false }
                event.currentTarget.setPointerCapture(event.pointerId)
                return
              }
              const snapped = snapTime(time)
              const note: ChartNote = {
                id: createId('note'),
                lane,
                time: snapped,
                beat: timing.timeToBeat(snapped),
                step: timing.timeToStep(snapped, chart.stepsPerBeat),
                kind: 'tap',
                strength: 1,
              }
              const before = chart.notes
              commitNotes([...before, note], { undo: before })
              setSelection(note.id)
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current
              if (!drag) return
              const rect = event.currentTarget.getBoundingClientRect()
              const time = timeFromX(event.clientX - rect.left, rect.width) - drag.grabTime
              const y = event.clientY - rect.top
              const lane = Math.max(0, Math.min(3, Math.floor(((y - 22) / Math.max(1, rect.height - 22)) * 4))) as Lane
              const target = chart.notes.find((note) => note.id === drag.noteId)
              if (!target) return
              const snappedTime = snapTime(time)
              const snappedLane = event.altKey ? lane : lane
              if (Math.abs(target.time - snappedTime) < 1e-6 && target.lane === snappedLane) return
              const before = drag.before
              const moved = before.map((note) =>
                note.id === drag.noteId
                  ? { ...note, time: snappedTime, lane: snappedLane, beat: timing.timeToBeat(snappedTime), step: timing.timeToStep(snappedTime, chart.stepsPerBeat) }
                  : note,
              )
              commitNotes(moved, drag.moved ? {} : { undo: before })
              drag.moved = true
            }}
            onPointerUp={() => {
              dragRef.current = null
            }}
            onWheel={(event) => {
              event.preventDefault()
              if (event.ctrlKey) {
                const factor = event.deltaY > 0 ? 1.15 : 0.87
                setCamera((current) => ({ ...current, span: Math.max(1.5, Math.min(120, current.span * factor)) }))
                return
              }
              setCamera((current) => ({
                ...current,
                start: Math.max(0, current.start + (event.deltaY / 400) * current.span),
              }))
            }}
          />
        </div>

        <div className="row gap-12 wrap mt-12">
          <Button size="sm" variant="ghost" onClick={() => setCamera((c) => ({ ...c, start: Math.max(0, c.start - c.span * 0.5) }))}>
            ⇤ −half screen
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCamera((c) => ({ ...c, start: c.start + c.span * 0.5 }))}>
            +half screen ⇥
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCamera({ start: 0, span: 12 })}>
            Reset view
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setCamera((c) => ({ ...c, start: Math.max(0, playhead - c.span / 4) }))}>
            Follow playhead
          </Button>
          <span className="editor-hint">
            Left-click empty space to add · drag a note to move · right-click to delete · click the time ruler to move the
            playhead · wheel scrolls · Ctrl+wheel zooms ·
            Space plays · arrows nudge · Del deletes · Ctrl+Z undoes
          </span>
        </div>

        <div className="grid cols-3 mt-16">
          <label className="field">
            <span className="field-label">Camera span (seconds)</span>
            <input
              type="number"
              min={1.5}
              max={120}
              step={0.5}
              value={Number(camera.span.toFixed(2))}
              onChange={(event) => setCamera((c) => ({ ...c, span: Math.max(1.5, Math.min(120, Number(event.target.value) || 12)) }))}
            />
          </label>
          <label className="field">
            <span className="field-label">View start (seconds)</span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={Number(camera.start.toFixed(2))}
              onChange={(event) => setCamera((c) => ({ ...c, start: Math.max(0, Number(event.target.value) || 0) }))}
            />
          </label>
          <Select
            label="Grid resolution"
            value={String(chart.stepsPerBeat)}
            options={[
              { value: '2', label: '1/8 notes (2 steps/beat)' },
              { value: '3', label: '1/12 notes (3 steps/beat)' },
              { value: '4', label: '1/16 notes (4 steps/beat)' },
              { value: '6', label: '1/24 notes (6 steps/beat)' },
              { value: '8', label: '1/32 notes (8 steps/beat)' },
            ]}
            onChange={(value) => regrid(timing, Number(value))}
          />
        </div>
      </Panel>

      <Panel title="Timing" subtitle="A new BPM or offset applies when you press Enter or leave the box, and re-snaps every note to the grid.">
        <div className="grid cols-3">
          <label className="field">
            <span className="field-label">BPM</span>
            <input
              type="number"
              min={30}
              max={320}
              step={0.01}
              value={bpmDraft ?? String(Number(timing.primaryBpm.toFixed(3)))}
              onChange={(event) => setBpmDraft(event.target.value)}
              onBlur={applyBpmDraft}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
          </label>
          <label className="field">
            <span className="field-label">Offset (ms at beat 0)</span>
            <input
              type="number"
              step={1}
              value={offsetDraft ?? String(Math.round(timing.offset * 1000))}
              onChange={(event) => setOffsetDraft(event.target.value)}
              onBlur={applyOffsetDraft}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur()
              }}
            />
          </label>
          <div className="col gap-8">
            <Button
              size="sm"
              onClick={() => regrid(timing, chart.stepsPerBeat)}
            >
              Re-snap all notes to grid
            </Button>
            <span className="muted tiny">
              Grid: {chart.stepsPerBeat} steps/beat · {(timing.secondsPerBeat(0) * 1000).toFixed(1)} ms per beat
            </span>
          </div>
        </div>
      </Panel>

      <Panel title="Validation">
        <div className="grid cols-3">
          <Stat label="Notes" value={chart.notes.length} />
          <Stat label="Peak NPS" value={chart.stats.peakNps.toFixed(2)} />
          <Stat label="Rating" value={chart.stats.rating.toFixed(1)} />
        </div>
        <div className="mt-16">
          {playability.ok ? (
            <Chip color="#009e73">Playable — no errors, {playability.warnings} warnings</Chip>
          ) : (
            <Chip color="#d55e00">{playability.errors} errors, {playability.warnings} warnings</Chip>
          )}
          <ul className="bullets muted small mt-12">
            {errors.slice(0, 6).map((issue, index) => (
              <li key={`error-${index}`} className="bad">
                {issue.message} {issue.noteIds.length > 0 && <span className="faint">({issue.noteIds.length} notes)</span>}
              </li>
            ))}
            {warnings.slice(0, 8).map((issue, index) => (
              <li key={`warn-${index}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
        {smResult && (
          <div className="mt-16">
            <h3 className={smResult.ok ? 'good' : 'bad'}>
              {smResult.ok ? 'StepMania export is valid' : 'StepMania export blocked'}
            </h3>
            <ul className="bullets muted small mt-8">
              {smResult.errors.map((error, index) => (
                <li key={`sm-error-${index}`} className="bad">
                  {error}
                </li>
              ))}
              {smResult.warnings.map((warning, index) => (
                <li key={`sm-warn-${index}`}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
        {importWarnings && importWarnings.length > 0 && (
          <div className="mt-16">
            <h3>Import warnings</h3>
            <ul className="bullets muted small mt-8">
              {importWarnings.map((warning, index) => (
                <li key={`import-${index}`}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
    </div>
  )
}
