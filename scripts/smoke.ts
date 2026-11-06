/**
 * CLI smoke test: runs the whole offline pipeline in Node — synthetic rhythm → analysis → grid
 * fitting → four charts → playability validation → serialization round trips.
 *
 * `npm run smoke` is the fastest way to check that a code change did not break the pipeline
 * without opening a browser. It needs no audio files and no network.
 */
import { analyzeSamples } from '../src/audio/analyze'
import { renderTestRhythm } from '../src/audio/synth'
import { generateAllDifficulties, validatePlayability } from '../src/chart/generate'
import { exportSm, parseChartFile, serializeChart } from '../src/chart/serialize'
import { TimingMap } from '../src/chart/timing'
import { finalAccuracy, gradeFor } from '../src/game/score'

let failures = 0

function check(label: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const truth = renderTestRhythm({ bpm: 150, bars: 20, sampleRate: 32000, melody: true })
console.log(`synthetic rhythm: ${truth.bpm} BPM, ${truth.duration.toFixed(1)}s, offset ${truth.offset.toFixed(3)}s`)

const analysis = analyzeSamples(truth.samples, truth.sampleRate)
const bpmError = Math.abs(analysis.bpm - truth.bpm)
check('BPM within 0.5%', bpmError / truth.bpm < 0.005, `detected ${analysis.bpm.toFixed(3)}`)
check(
  'beat phase within 25 ms of the true first beat',
  Math.abs(analysis.offset - truth.offset) < 0.025,
  `${(analysis.offset * 1000).toFixed(1)} ms vs ${(truth.offset * 1000).toFixed(1)} ms`,
)
check('onset count is plausible', analysis.onsets.length > 40, `${analysis.onsets.length} onsets`)
check(
  'analysis reports its confidence honestly',
  analysis.bpmConfidence > 0.7 && analysis.gridResidualMs < 25,
  `confidence ${analysis.bpmConfidence.toFixed(2)}, residual ${analysis.gridResidualMs.toFixed(1)} ms`,
)

const timing = TimingMap.single(analysis.bpm, analysis.offset)
const charts = generateAllDifficulties({
  analysis,
  timing,
  duration: truth.duration,
  songId: 'smoke-song',
  title: 'Smoke Test Rhythm',
})
check('four charts generated', charts.length === 4)

const counts = charts.map((chart) => chart.stats.noteCount)
check(
  'density increases with difficulty',
  counts.every((count, index) => index === 0 || count >= counts[index - 1]),
  counts.join(' ≤ '),
)

for (const chart of charts) {
  const report = validatePlayability(chart, truth.duration)
  check(
    `${chart.difficulty} chart is playable`,
    report.ok,
    `${chart.stats.noteCount} notes, rating ${chart.stats.rating.toFixed(1)}, ${report.warnings} warnings`,
  )
}

const expert = charts[3]
const json = serializeChart(expert, { title: 'Smoke', artist: '', fileName: 'smoke.wav', duration: truth.duration })
const parsed = parseChartFile(json)
check('JSON export/import round trip', parsed.ok && parsed.chart.notes.length === expert.notes.length)

const sm = exportSm(expert, { title: 'Smoke', artist: '', musicFileName: 'smoke.wav', rowsPerBeat: expert.stepsPerBeat })
check('valid .sm export', sm.ok, sm.errors.join('; ') || `${(sm.text.length / 1024).toFixed(1)} KB`)
if (sm.ok) {
  const noteLines = sm.text.split('#NOTES:')[1]?.split('\n').filter((line) => /^[0-9LDUR]{4}$/.test(line.trim())) ?? []
  const noteCount = noteLines.join('').replace(/[03]/g, '').length // hold tails (3) are not extra notes
  check('.sm contains every note', noteCount === expert.notes.length, `${noteCount} vs ${expert.notes.length}`)
}

const grade = gradeFor(finalAccuracy({ marvelous: 100, perfect: 0, great: 0, good: 0, miss: 0 }, 100))
check('perfect run grades SSS', grade.label === 'SSS', grade.label)

console.log(failures === 0 ? '\nall smoke checks passed' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
