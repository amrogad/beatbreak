/** A short, plain-language walkthrough shown once and available from every screen. */
import React, { useEffect, useState } from 'react'
import { Button } from './components'
import { PlayfieldPreview } from './PlayfieldPreview'

export interface TutorialProps {
  open: boolean
  onClose: () => void
}

const STEPS = [
  {
    title: 'Add a song you own',
    body: 'Pick an MP3, WAV, OGG, M4A, or FLAC file. PULSEGRID listens to the track and finds its beat.',
  },
  {
    title: 'We build four charts',
    body: 'Easy keeps a steady beat. Normal adds a single-arrow stream. Hard brings faster runs and occasional jumps. Expert follows every hit, with rare three- and four-arrow accents. The app picks a starting difficulty from the song.',
  },
  {
    title: 'Hit the arrows',
    body: 'Use W A S D or the arrow keys. On a phone, tap the lane under each arrow. Hit when the arrow reaches the target at the top (or bottom, if you changed the direction).',
  },
  {
    title: 'Hold the long arrows',
    body: 'Press when the arrow reaches the target, keep holding, and let go when the end arrow reaches the target. Letting go early misses it. Prefer to just hold until the end? Change Long arrows in Settings.',
  },
] as const

function LaneArt(): React.JSX.Element {
  // The real playfield on auto-play, with each column's keys underneath it.
  return (
    <div className="tutorial-art" aria-hidden="true">
      <PlayfieldPreview />
      <div className="tutorial-keys">
        {['A  ←', 'S  ↓', 'W  ↑', 'D  →'].map((label) => (
          <span className="keycap" key={label}>
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}

export function Tutorial({ open, onClose }: TutorialProps): React.JSX.Element | null {
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (!open) return
    setStep(0)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const current = STEPS[step]
  const last = step === STEPS.length - 1

  return (
    <div className="tutorial-overlay" role="dialog" aria-modal="true" aria-labelledby="tutorial-title">
      <div className="tutorial-card">
        <div className="row-between gap-12">
          <span className="eyebrow">How to play · {step + 1} of {STEPS.length}</span>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close walkthrough">
            ✕
          </Button>
        </div>
        <h2 id="tutorial-title" className="mt-8">{current.title}</h2>
        <p className="muted mt-8">{current.body}</p>
        {step === 2 && <LaneArt />}
        <div className="tutorial-dots" aria-hidden="true">
          {STEPS.map((item, index) => (
            <span key={item.title} className={index === step ? 'is-current' : ''} />
          ))}
        </div>
        <div className="row-between gap-12 mt-16">
          <Button variant="ghost" onClick={onClose}>
            Skip
          </Button>
          <div className="row gap-8">
            {step > 0 && (
              <Button onClick={() => setStep((value) => Math.max(0, value - 1))}>Back</Button>
            )}
            <Button variant="primary" onClick={() => (last ? onClose() : setStep((value) => value + 1))}>
              {last ? 'Start playing' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
