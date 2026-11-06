import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { TrimRange } from '../audio/trim'
import { formatDuration } from './format'

interface TrimEditorProps {
  peaks: Uint8Array
  duration: number
  /** Parts of the song that no longer play. */
  removed: TrimRange[]
  selection: TrimRange | null
  disabled: boolean
  onSelect: (range: TrimRange | null) => void
}

const MIN_DRAG_SECONDS = 0.3

function drawPeaks(canvas: HTMLCanvasElement, peaks: Uint8Array): void {
  const { width, height } = canvas.getBoundingClientRect()
  const ratio = Math.min(2, window.devicePixelRatio || 1)
  canvas.width = Math.max(1, Math.round(width * ratio))
  canvas.height = Math.max(1, Math.round(height * ratio))
  const context = canvas.getContext('2d')
  if (!context) return
  context.fillStyle = getComputedStyle(canvas).color
  const bars = Math.floor(canvas.width / (2 * ratio))
  const barWidth = Math.max(1, Math.round(ratio))
  for (let bar = 0; bar < bars; bar++) {
    const from = Math.floor((bar / bars) * peaks.length)
    const to = Math.max(from + 1, Math.floor(((bar + 1) / bars) * peaks.length))
    let peak = 0
    for (let i = from; i < to; i++) peak = Math.max(peak, peaks[i])
    const size = Math.max(ratio, (peak / 255) * canvas.height * 0.92)
    context.fillRect(bar * 2 * ratio, (canvas.height - size) / 2, barWidth, size)
  }
}

export function TrimEditor({ peaks, duration, removed, selection, disabled, onSelect }: TrimEditorProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const anchorRef = useRef<number | null>(null)
  const [dragging, setDragging] = useState<TrimRange | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver(() => drawPeaks(canvas, peaks))
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [peaks])

  const timeAt = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): number => {
      const box = event.currentTarget.getBoundingClientRect()
      return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * duration
    },
    [duration],
  )

  const shown = dragging ?? selection
  const place = (range: TrimRange): React.CSSProperties => ({
    left: `${(range.start / duration) * 100}%`,
    width: `${((range.end - range.start) / duration) * 100}%`,
  })

  return (
    <div
      className={`trim-wave${disabled ? ' is-disabled' : ''}`}
      role="application"
      aria-label="Song waveform. Drag to highlight a part."
      onPointerDown={(event) => {
        if (disabled) return
        event.currentTarget.setPointerCapture(event.pointerId)
        anchorRef.current = timeAt(event)
        setDragging(null)
      }}
      onPointerMove={(event) => {
        const anchor = anchorRef.current
        if (anchor === null) return
        const time = timeAt(event)
        setDragging({ start: Math.min(anchor, time), end: Math.max(anchor, time) })
      }}
      onPointerUp={() => {
        anchorRef.current = null
        onSelect(dragging && dragging.end - dragging.start >= MIN_DRAG_SECONDS ? dragging : null)
        setDragging(null)
      }}
      onPointerCancel={() => {
        anchorRef.current = null
        setDragging(null)
      }}
    >
      <canvas ref={canvasRef} className="trim-peaks" />
      {removed.map((range) => (
        <div key={`${range.start}-${range.end}`} className="trim-removed" style={place(range)} />
      ))}
      {shown && (
        <div className="trim-selection" style={place(shown)}>
          <span className="trim-time">
            {formatDuration(shown.start)}–{formatDuration(shown.end)}
          </span>
        </div>
      )}
    </div>
  )
}
