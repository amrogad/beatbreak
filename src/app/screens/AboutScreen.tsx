/** About: what the game is, where the music goes, and how to report a problem. */
import React from 'react'
import { BackButton, Panel } from '../components'

export interface AboutScreenProps {
  onBack: () => void
}

const BUG_MAILTO = 'mailto:amro9gad@gmail.com'

export function AboutScreen({ onBack }: AboutScreenProps): React.JSX.Element {
  return (
    <div className="page narrow">
      <div className="title-row">
        <BackButton onClick={onBack} />
        <h1>About</h1>
      </div>

      <Panel title="Your music. Your moves.">
        <p className="muted">
          Beatbreak is a four-lane rhythm game built from the music you already own. Add a track
          and it listens for the beat, turns the hits into arrows, and builds four difficulties for
          you to play. No chart packs, no accounts, no uploads.
        </p>
        <p className="muted mt-12">
          Each run is scored on timing and combo. Tap the arrows, hold the long notes, and chase a
          higher score on every song in your library.
        </p>
      </Panel>

      <Panel title="Local, private and offline">
        <p className="muted">
          Analysis happens on this device. Your audio never leaves the browser, and nothing is
          uploaded to a server. Songs, charts, scores and cached audio live in local browser
          storage, so the library is there the next time you open the app.
        </p>
        <p className="muted mt-12">
          After the first visit the game is cached for offline play. Once it has loaded, you can
          keep playing without a connection.
        </p>
        <p className="muted mt-12">
          Menu music:{' '}
          <a href="https://pixabay.com/music/beats-no-copyright-music-270241/" target="_blank" rel="noreferrer">
            No Copyright Music
          </a>{' '}
          by Kulakovka, from Pixabay.
        </p>
      </Panel>

      <Panel title="Found a bug?">
        <p className="muted">
          Tell us what happened, what you expected, and which browser you were using. A short list
          of steps helps more than a long description.
        </p>
        <a className="btn btn-primary mt-16" href={BUG_MAILTO}>
          Report a bug
        </a>
      </Panel>
    </div>
  )
}
