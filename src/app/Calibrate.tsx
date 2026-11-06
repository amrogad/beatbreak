/** Tap along with a click to set Audio sync for the player's own speakers or headphones. */
import React, { useEffect, useRef, useState } from 'react'
import { estimateOutputLatency, getAudioContext, resumeAudioContext } from '../audio/engine'
import { calibrate, CALIBRATION_MIN_TAPS, CALIBRATION_WARMUP, type CalibrationResult } from '../game/calibration'
import { formatSync } from './format'
import { Button, Modal } from './components'

const BPM = 100
const CLICKS = 24
const BEAT = 60 / BPM

export function CalibrateDialog({
  onApply,
  onClose,
}: {
  onApply: (audioOffsetMs: number) => void
  onClose: () => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<'ready' | 'running' | 'done'>('ready')
  const [taps, setTaps] = useState(0)
  const [result, setResult] = useState<CalibrationResult | null>(null)
  const clicksRef = useRef<number[]>([])
  const delaysRef = useRef<number[]>([])
  const latencyRef = useRef(0)
  const timerRef = useRef<number | null>(null)

  const start = async (): Promise<void> => {
    await resumeAudioContext()
    const ctx = getAudioContext()
    latencyRef.current = estimateOutputLatency(ctx) * 1000
    delaysRef.current = []
    setTaps(0)
    setResult(null)
    const first = ctx.currentTime + 0.6
    clicksRef.current = Array.from({ length: CLICKS }, (_, i) => first + i * BEAT)
    for (const [i, at] of clicksRef.current.entries()) {
      const osc = ctx.createOscillator()
      const env = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = i % 4 === 0 ? 1600 : 1100
      env.gain.setValueAtTime(0.0001, at)
      env.gain.exponentialRampToValueAtTime(0.16, at + 0.003)
      env.gain.exponentialRampToValueAtTime(0.0001, at + 0.06)
      osc.connect(env)
      env.connect(ctx.destination)
      osc.start(at)
      osc.stop(at + 0.08)
    }
    setPhase('running')
    const endsInMs = (first - ctx.currentTime + CLICKS * BEAT + 0.4) * 1000
    timerRef.current = window.setTimeout(() => {
      setResult(calibrate(delaysRef.current, latencyRef.current))
      setPhase('done')
    }, endsInMs)
  }

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
  }, [])

  useEffect(() => {
    if (phase !== 'running') return
    const tap = (timeStamp: number): void => {
      const ctx = getAudioContext()
      // When the tap happened, on the audio clock.
      const at = ctx.currentTime - Math.max(0, performance.now() - timeStamp) / 1000
      let nearest = clicksRef.current[0]
      for (const click of clicksRef.current) if (Math.abs(click - at) < Math.abs(nearest - at)) nearest = click
      delaysRef.current.push((at - nearest) * 1000)
      setTaps((count) => count + 1)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.repeat || event.key === 'Escape' || event.key === 'Tab') return
      event.preventDefault()
      tap(event.timeStamp)
    }
    const onPointer = (event: PointerEvent): void => {
      if ((event.target as HTMLElement | null)?.closest('button')) return
      tap(event.timeStamp)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [phase])

  return (
    <Modal title="Calibrate audio sync" onClose={onClose}>
      {phase === 'ready' && (
        <>
          <p>Use the speakers or headphones you play with. You will hear {CLICKS} clicks. Tap any key, or tap the screen, on every click.</p>
          <div className="row gap-8 wrap mt-16">
            <Button variant="primary" onClick={() => void start()}>
              Start
            </Button>
          </div>
        </>
      )}
      {phase === 'running' && (
        <div className="calibrate-pad" aria-live="polite">
          <p className="calibrate-count">{taps}</p>
          <p className="muted small">{taps < CALIBRATION_WARMUP ? 'Find the beat, then keep tapping on every click.' : 'Keep going, steady.'}</p>
        </div>
      )}
      {phase === 'done' && (
        <>
          {result ? (
            <>
              <p>
                Your taps land {Math.abs(result.delayMs)} ms {result.delayMs >= 0 ? 'after' : 'before'} the click, give or take {result.spreadMs} ms.
              </p>
              <p className="mt-8">
                Audio sync: <strong>{formatSync(result.audioOffsetMs)}</strong>
              </p>
              {result.spreadMs > 40 && <p className="muted small mt-8">The taps were uneven. Try again for a steadier reading.</p>}
            </>
          ) : (
            <p>Not enough taps on the clicks to measure (at least {CALIBRATION_MIN_TAPS + CALIBRATION_WARMUP}). Try again.</p>
          )}
          <div className="row gap-8 wrap mt-16">
            {result && (
              <Button
                variant="primary"
                onClick={() => {
                  onApply(result.audioOffsetMs)
                  onClose()
                }}
              >
                Use it
              </Button>
            )}
            <Button onClick={() => void start()}>Try again</Button>
          </div>
        </>
      )}
    </Modal>
  )
}
