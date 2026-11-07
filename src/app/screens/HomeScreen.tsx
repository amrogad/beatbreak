/** Home: add a song, replay something from the library, or open the walkthrough. */
import React, { useEffect, useRef, useState } from 'react'
import type { Difficulty, SongMeta } from '../../core/types'
import { DIFFICULTY_COLOR, DIFFICULTY_LABEL } from '../../core/types'
import { Button, Chip, Panel } from '../components'
import { PlayfieldPreview } from '../PlayfieldPreview'
import { formatDuration } from '../format'
import type { BestScoreEntry, BestScores } from './bestScores'

export interface HomeScreenProps {
  songs: SongMeta[]
  loading: boolean
  /** The library could not be read: say so and offer a retry instead of an empty list. */
  loadError: string | null
  onRetryLoad: () => void
  bestScores: BestScores
  storageAvailable: boolean
  onImport: (file: File, total?: number) => void
  onPlayDemo: () => void
  onOpenSong: (songId: string) => void
  onDeleteSong: (songId: string) => void
  onClearAll: () => void
}

const DIFFICULTY_ORDER: Difficulty[] = ['easy', 'normal', 'hard', 'expert']

/** The single best run on a song, regardless of which chart earned it. */
function highestScore(
  scores: Partial<Record<Difficulty, BestScoreEntry>> | undefined,
): { difficulty: Difficulty; entry: BestScoreEntry } | null {
  let best: { difficulty: Difficulty; entry: BestScoreEntry } | null = null
  for (const difficulty of DIFFICULTY_ORDER) {
    const entry = scores?.[difficulty]
    if (!entry) continue
    if (!best || entry.score > best.entry.score) best = { difficulty, entry }
  }
  return best
}

export function HomeScreen({
  songs,
  loading,
  loadError,
  onRetryLoad,
  bestScores,
  storageAvailable,
  onImport,
  onPlayDemo,
  onOpenSong,
  onDeleteSong,
  onClearAll,
}: HomeScreenProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const accept = (files: FileList | null): void => {
    const file = files?.[0]
    if (file) onImport(file, files?.length ?? 1)
  }

  const deleting = confirmDelete ? songs.find((song) => song.id === confirmDelete) ?? null : null

  useEffect(() => {
    if (!confirmDelete) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setConfirmDelete(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmDelete])

  return (
    <div className="page">
      <section
        className={`hero${dragging ? ' dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          accept(event.dataTransfer.files)
        }}
      >
        <div className="hero-grid">
          <div>
            <h1>
              <span>Your music.</span>
              <span>Your moves.</span>
            </h1>
            <p className="muted">
              Turn any song into a four-arrow rhythm game. Upload a track, hit the notes in time
              with the beat, and see how high you can score.
            </p>
            <div className="hero-actions row gap-8 wrap mt-16">
              <Button variant="primary" size="lg" onClick={() => inputRef.current?.click()}>
                Add a song
              </Button>
              <Button size="lg" variant="ghost" onClick={onPlayDemo} title="A built-in demo track, no file needed">
                Try a demo
              </Button>
            </div>
          </div>
          <div className="hero-side">
            <div className="hero-preview" aria-hidden="true">
              <PlayfieldPreview />
            </div>
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*,.wav,.mp3,.ogg,.m4a,.flac,.opus,.aac,.webm"
          style={{ display: 'none' }}
          onChange={(event) => {
            accept(event.target.files)
            event.target.value = ''
          }}
        />
      </section>

      {!storageAvailable && (
        <Panel title="Storage is blocked">
          <p className="muted">
            This browser is blocking local storage (private windows often do). You can still add and play a song,
            but it will not be here next time.
          </p>
        </Panel>
      )}

      <Panel
        title="Your songs"
        subtitle={loading ? 'Loading…' : songs.length === 1 ? '1 song' : `${songs.length} songs`}
        actions={
          songs.length > 0 ? (
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (window.confirm(`Remove all ${songs.length} songs, their charts and scores?`)) onClearAll()
              }}
            >
              Clear all songs
            </Button>
          ) : undefined
        }
      >
        {loadError && (
          <div className="empty-state" role="alert">
            <h3>Your songs did not load</h3>
            <p className="muted small">
              They are most likely still saved. Another Beatbreak tab may be updating the library: close it, then try again. ({loadError})
            </p>
            <Button variant="primary" onClick={onRetryLoad}>
              Try again
            </Button>
          </div>
        )}
        {songs.length === 0 && !loading && !loadError && (
          <div className="empty-state">
            <h3>Nothing here yet</h3>
            <p className="muted small">
              Add an audio file and the first chart is usually ready in a few seconds.
            </p>
            <Button variant="primary" onClick={() => inputRef.current?.click()}>
              Add a song
            </Button>
          </div>
        )}
        <div className="song-list">
          {songs.map((song) => {
            const scores = bestScores[song.id]
            const bestRun = highestScore(scores)
            return (
              <div className="song-row" key={song.id}>
                <div className="song-main">
                  <span className="song-title truncate">{song.title}</span>
                  <div className="song-meta">
                    {song.artist && <span className="muted tiny">{song.artist}</span>}
                    {!song.audioCached && <Chip color="#ffb02e" tone="outline">File needed</Chip>}
                  </div>
                  {bestRun && (
                    <div className="song-high-score">
                      <span>
                        High score: <strong>{bestRun.entry.score.toLocaleString('en-US')}</strong>
                      </span>
                      <span>
                        <span style={{ color: DIFFICULTY_COLOR[bestRun.difficulty] }}>{DIFFICULTY_LABEL[bestRun.difficulty]}</span>
                        {` - Grade ${bestRun.entry.grade} - Accuracy: ${Math.round(bestRun.entry.accuracy * 100)}%`}
                      </span>
                    </div>
                  )}
                </div>
                <span className="song-duration mono">{formatDuration(song.duration)}</span>
                <div className="song-actions">
                  <Button variant="primary" onClick={() => onOpenSong(song.id)} aria-label={`Play ${song.title}`}>
                    Play
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => setConfirmDelete(song.id)}
                    title="Delete this song, its charts and its scores"
                    aria-label={`Delete ${song.title}`}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </Panel>

      {deleting && (
        <div
          className="tutorial-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfirmDelete(null)
          }}
        >
          <div
            className="tutorial-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-song-title"
          >
            <h2 id="delete-song-title">Delete this song?</h2>
            <p className="small mt-8">
              Remove <b>{deleting.title}</b>, its four charts, saved audio and score history?
              This cannot be undone.
            </p>
            <div className="row gap-8 mt-16">
              <Button
                variant="danger"
                onClick={() => {
                  onDeleteSong(deleting.id)
                  setConfirmDelete(null)
                }}
              >
                Delete permanently
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

