/** Results: grade, accuracy breakdown, history, replay. */
import React from 'react'
import type { Chart, RunResults, SongMeta } from '../../core/types'
import { DIFFICULTY_COLOR, DIFFICULTY_LABEL, JUDGMENTS } from '../../core/types'
import type { StoredRun } from '../../store/db'
import { JUDGMENT_COLOR, JUDGMENT_LABEL } from '../../game/judgment'
import { comboRecognition, gradeFor, maxScore, DIFFICULTY_SCORE_SCALE } from '../../game/score'
import { Icon, Button, Chip, Panel, Stat } from '../components'
import { formatPercent } from '../format'

export interface ResultsScreenProps {
  results: RunResults
  song: SongMeta
  chart: Chart
  previousBest: StoredRun | null
  isNewBest: boolean
  history: StoredRun[]
  onRetry: () => void
  onSetup: () => void
  onHome: () => void
  onExportChart: () => void
}

export function ResultsScreen({
  results,
  song,
  chart,
  previousBest,
  isNewBest,
  history,
  onRetry,
  onSetup,
  onHome,
  onExportChart,
}: ResultsScreenProps): React.JSX.Element {
  const grade = gradeFor(results.accuracy, results.failed)
  const max = maxScore(results.totalNotes, DIFFICULTY_SCORE_SCALE[results.difficulty] ?? 1)
  const percentage = max > 0 ? results.score / max : 0
  // A failed run stopped where the fail rule was met; the arrows after that were never played.
  const judged = JUDGMENTS.reduce((sum, judgment) => sum + results.tally[judgment], 0)
  const notPlayed = Math.max(0, results.totalNotes - judged)
  // StepMania recognition, from the tested helper: a full combo is every note judged with no
  // miss and no dropped hold; an all-marvelous run earns its own title. Auto-play never qualifies.
  const combo = comboRecognition(results)
  const things = results.mode === 'circles' ? 'circles' : 'arrows'
  const fullCombo = combo !== null
  const marvelousFullCombo = combo === 'marvelous-full-combo'

  return (
    <div className="page narrow">
      <div className="row-between wrap gap-16">
        <div>
          <Chip color={DIFFICULTY_COLOR[chart.difficulty]}>{DIFFICULTY_LABEL[chart.difficulty]}</Chip>
          <h1 className="mt-8">{song.title}</h1>
          <p className="muted small">{results.totalNotes} {things} in this chart</p>
        </div>
        {results.autoPlay && <Chip color="#ff7a3d">Auto-play — not counted as a score</Chip>}
      </div>

      <Panel>
        <div className="row-between wrap gap-24">
          <div className="row gap-24 wrap">
            <div className="grade-badge" style={{ color: grade.color }}>
              {grade.label}
            </div>
            <div className="col gap-12">
              <Stat
                label="Score"
                value={results.score.toLocaleString('en-US')}
                hint={`${formatPercent(percentage)} of the ${max.toLocaleString('en-US')} maximum`}
              />
              <Stat label="Accuracy" value={formatPercent(results.accuracy, 2)} color={grade.color}
                hint={
                  results.failed && notPlayed > 0
                    ? `counts only the ${things} you reached before the run ended`
                    : undefined
                }
              />
              <Stat label="Best combo" value={results.bestCombo} />
              {(results.droppedHolds ?? 0) > 0 && (
                <Stat
                  label={results.mode === 'circles' ? 'Sliders dropped' : 'Long arrows dropped'}
                  value={results.droppedHolds ?? 0}
                  color="#ff7a3d"
                  hint={`released before the ${results.mode === 'circles' ? 'slider' : 'tail'} ended; each one counts as a miss`}
                />
              )}
            </div>
          </div>
          <div className="col gap-12">
            {results.failed && (
              <Chip color="#ff4f9a">
                Run ended after {judged.toLocaleString('en-US')} of {results.totalNotes.toLocaleString('en-US')} {things}
              </Chip>
            )}
            {isNewBest && !results.autoPlay && <Chip color="#ffc93d">New personal best</Chip>}
            {!isNewBest && !previousBest && !results.autoPlay && !results.failed && results.score > 0 && (
              <Chip color="#3fe08a">First score on this chart</Chip>
            )}
            {marvelousFullCombo && <Chip color="#3de9ff">Marvelous full combo</Chip>}
            {fullCombo && !marvelousFullCombo && <Chip color="#3fe08a">Full combo</Chip>}
            {!isNewBest && previousBest && !results.autoPlay && (
              <Stat
                label="Previous best"
                value={previousBest.score.toLocaleString('en-US')}
                hint={`${formatPercent(previousBest.accuracy, 2)} - ${previousBest.grade}`}
              />
            )}
            {previousBest && results.score < previousBest.score && !results.autoPlay && (
              <span className="muted small">
                {(previousBest.score - results.score).toLocaleString('en-US')} points behind your best.
              </span>
            )}
          </div>
        </div>

        <div className="tally-grid mt-24">
          {JUDGMENTS.map((judgment) => (
            <div className="tally-cell" key={judgment}>
              <div className="count" style={{ color: JUDGMENT_COLOR[judgment] }}>
                {results.tally[judgment]}
              </div>
              <div className="label" style={{ color: JUDGMENT_COLOR[judgment] }}>
                {JUDGMENT_LABEL[judgment]}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="row gap-12 wrap">
        <Button variant="primary" size="lg" onClick={onRetry}>
          <Icon name="replay" />
          Play again
        </Button>
        <Button size="lg" onClick={onSetup}>
          Change difficulty
        </Button>
        <Button variant="ghost" size="lg" onClick={onHome}>
          Back
        </Button>
        <Button variant="ghost" size="lg" onClick={onExportChart}>
          Save chart file
        </Button>
      </div>

      {history.length > 0 && (
        <Panel title="Recent runs on this chart">
          <ul className="plain">
            {history.map((run) => (
              <li key={run.id} className="row-between gap-12 small">
                <span className="mono muted">
                  {new Date(run.createdAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
                <span className="mono">{run.score.toLocaleString('en-US')}</span>
                <span className="mono">{formatPercent(run.accuracy, 2)}</span>
                <span className="mono" style={{ color: gradeFor(run.accuracy, run.failed).color }}>
                  {run.grade}
                </span>
                <span className="muted nowrap">{run.failed ? 'failed' : `${run.bestCombo}x combo`}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  )
}
