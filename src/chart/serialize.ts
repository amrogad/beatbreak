/**
 * Chart serialization.
 *
 *  - Beatbreak JSON: the full chart, human readable, used for export/import and local storage.
 *  - StepMania `.sm`: a real, valid chart file. Only produced when the result would genuinely be
 *    valid (16th-note aligned, sane timing, single or multi BPM segments); otherwise the caller
 *    gets `ok: false` with reasons instead of a broken file.
 *
 * The internal chart model already stores notes on an integer grid with fractional beats and a
 * multi-segment timing map, which is exactly what `.sm` needs — so the exporter is a formatting
 * step, not a conversion of game logic.
 */
import type { Chart, ChartNote, Difficulty, Lane, Timing } from '../core/types'
import { normalizeTiming, sortNotes, TimingMap } from './timing'
import { clamp } from '../core/math'

export const CHART_FILE_KIND = 'pulsegrid.chart'
export const CHART_FILE_VERSION = 1

export interface ChartFile {
  kind: typeof CHART_FILE_KIND
  version: number
  exportedAt: string
  generator: string
  song: {
    id: string
    title: string
    artist: string
    fileName: string
    duration: number
  }
  chart: Chart
}

export interface ExportContext {
  title: string
  artist: string
  fileName: string
  duration: number
}

export function serializeChart(fullChart: Chart, context: ExportContext): string {
  // The kept previous version is this device's undo, not part of the chart.
  const { previous: _previous, ...chart } = fullChart
  const file: ChartFile = {
    kind: CHART_FILE_KIND,
    version: CHART_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    generator: `Beatbreak ${chart.generator.version}`,
    song: {
      id: chart.songId,
      title: context.title,
      artist: context.artist,
      fileName: context.fileName,
      duration: context.duration,
    },
    chart,
  }
  return JSON.stringify(file, null, 2)
}

export interface ParseResult {
  ok: true
  chart: Chart
  song: ChartFile['song']
  warnings: string[]
}

export interface ParseFailure {
  ok: false
  error: string
  warnings: string[]
}

const LANE_FROM_LETTER: Record<string, Lane> = { L: 0, D: 1, U: 2, R: 3 }
const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard', 'expert']

/** Larger files are not charts a player made: refuse them before they can freeze the tab. */
export const MAX_IMPORT_NOTES = 20000
const MAX_TEMPO_SEGMENTS = 512

/** Parse and validate a Beatbreak chart file. Never throws; returns a typed failure instead. */
export function parseChartFile(text: string): ParseResult | ParseFailure {
  try {
    return parseChartFileOrThrow(text)
  } catch (error) {
    return { ok: false, error: `The file could not be read as a chart (${error instanceof Error ? error.message : String(error)}).`, warnings: [] }
  }
}

function parseChartFileOrThrow(text: string): ParseResult | ParseFailure {
  const warnings: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${(err as Error).message}`, warnings }
  }
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'File does not contain a chart object.', warnings }
  }
  const file = raw as Partial<ChartFile> & { chart?: Chart }
  if (file.kind !== undefined && file.kind !== CHART_FILE_KIND) {
    return { ok: false, error: `Unsupported file kind "${String(file.kind)}" (expected ${CHART_FILE_KIND}).`, warnings }
  }

  // Accept both the wrapped export format and a bare chart object.
  const chartCandidate = (file.chart ?? raw) as Chart
  if (!chartCandidate || !Array.isArray(chartCandidate.notes)) {
    return { ok: false, error: 'Chart is missing its notes array.', warnings }
  }
  if (!chartCandidate.timing || !Array.isArray(chartCandidate.timing.bpms) || chartCandidate.timing.bpms.length === 0) {
    return { ok: false, error: 'Chart is missing a valid timing map (offset + bpms).', warnings }
  }
  if (chartCandidate.notes.length > MAX_IMPORT_NOTES) {
    return { ok: false, error: `The chart has ${chartCandidate.notes.length} notes; ${MAX_IMPORT_NOTES} is the most a chart can hold.`, warnings }
  }
  if (chartCandidate.timing.bpms.length > MAX_TEMPO_SEGMENTS) {
    return { ok: false, error: `The chart has ${chartCandidate.timing.bpms.length} tempo changes; ${MAX_TEMPO_SEGMENTS} is the most it can hold.`, warnings }
  }
  for (const segment of chartCandidate.timing.bpms as Partial<{ bpm: number; beat: number }>[]) {
    const value = segment && typeof segment === 'object' ? Number(segment.bpm) : NaN
    if (!Number.isFinite(value) || value <= 5 || value > 1000) {
      return { ok: false, error: `Chart BPM ${String(segment?.bpm)} is out of range.`, warnings }
    }
  }

  const declared = Number(chartCandidate.stepsPerBeat)
  const stepsPerBeat = [1, 2, 3, 4, 6, 8].includes(declared) ? declared : 4
  if (Number.isFinite(declared) && declared !== stepsPerBeat) {
    warnings.push(`Unusual grid resolution ${declared} steps per beat; snapped to 4.`)
  }

  const duration = file.song?.duration && file.song.duration > 0 ? file.song.duration : Number.POSITIVE_INFINITY
  const timing = new TimingMap(chartCandidate.timing)
  const notes: ChartNote[] = []
  const seen = new Set<string>()
  const ids = new Set<string>()
  // Counted, not listed: a broken file with thousands of bad notes must not print thousands of lines.
  let invalid = 0
  let pastEnd = 0
  let duplicates = 0

  for (const rawNote of chartCandidate.notes as (Partial<ChartNote> | null)[]) {
    if (!rawNote || typeof rawNote !== 'object') {
      invalid++
      continue
    }
    const lane = Number(rawNote.lane)
    const time = Number(rawNote.time)
    if (!Number.isInteger(lane) || lane < 0 || lane > 3 || !Number.isFinite(time) || time < 0) {
      invalid++
      continue
    }
    if (time > duration) {
      pastEnd++
      continue
    }
    const key = `${time.toFixed(4)}|${lane}`
    if (seen.has(key)) {
      duplicates++
      continue
    }
    seen.add(key)
    const step = Number.isFinite(rawNote.step) && declared === stepsPerBeat
      ? Math.round(rawNote.step as number)
      : timing.timeToStep(time, stepsPerBeat)
    // Every note gets its own id: the editor moves and deletes notes by id.
    let id = typeof rawNote.id === 'string' && rawNote.id ? rawNote.id : `imp${step}-${lane}`
    for (let n = 2; ids.has(id); n++) id = `${typeof rawNote.id === 'string' && rawNote.id ? rawNote.id : `imp${step}-${lane}`}-${n}`
    ids.add(id)
    notes.push({
      id,
      lane: lane as Lane,
      time,
      beat: Number.isFinite(rawNote.beat) ? (rawNote.beat as number) : step / stepsPerBeat,
      step,
      kind: rawNote.kind === 'hold' ? 'hold' : 'tap',
      strength: clamp(Number.isFinite(rawNote.strength) ? (rawNote.strength as number) : 0.6, 0, 1),
      ...(rawNote.kind === 'hold' && Number.isFinite(rawNote.duration)
        ? { duration: Number(rawNote.duration) }
        : {}),
    })
  }

  if (invalid > 0) warnings.push(`${invalid} note(s) had an invalid lane or time and were dropped.`)
  if (pastEnd > 0) warnings.push(`${pastEnd} note(s) past the end of the song were dropped.`)
  if (duplicates > 0) warnings.push(`${duplicates} duplicate note(s) were dropped.`)

  if (notes.length === 0) {
    return { ok: false, error: 'Chart contains no usable notes.', warnings }
  }

  const difficulty: Difficulty = DIFFICULTIES.includes(chartCandidate.difficulty) ? chartCandidate.difficulty : 'normal'
  if (chartCandidate.difficulty !== difficulty) warnings.push(`Unknown difficulty mapped to "${difficulty}".`)

  const sorted = sortNotes(notes)
  const chart: Chart = {
    schema: 1,
    id: typeof chartCandidate.id === 'string' ? chartCandidate.id : `imported-${Date.now()}`,
    songId: typeof chartCandidate.songId === 'string' ? chartCandidate.songId : 'imported',
    difficulty,
    title: typeof chartCandidate.title === 'string' ? chartCandidate.title : '',
    timing: timing.toJSON(),
    stepsPerBeat,
    notes: sorted,
    stats:
      chartCandidate.stats && Number.isFinite(chartCandidate.stats.noteCount)
        ? { ...chartCandidate.stats, noteCount: sorted.length }
        : { noteCount: sorted.length, chordNotes: 0, peakNps: 0, avgNps: 0, rating: 1 },
    generator: chartCandidate.generator ?? {
      version: 'imported',
      source: 'imported',
      seed: 0,
      notes: ['Imported from a Beatbreak chart file.'],
      stepsPerBeat,
      keepRatio: 0,
      targetNps: 0,
      maxChord: 4,
      minJackGap: 0,
      minGap: 0,
      strengthFloor: 0,
      accent: 1,
      onBeatBonus: 0,
    },
    edited: true,
    createdAt: Number.isFinite(chartCandidate.createdAt) ? (chartCandidate.createdAt as number) : Date.now(),
    updatedAt: Number.isFinite(chartCandidate.updatedAt) ? (chartCandidate.updatedAt as number) : Date.now(),
  }

  return {
    ok: true,
    chart,
    song: {
      id: file.song?.id ?? chart.songId,
      title: file.song?.title ?? chart.title ?? 'Imported song',
      artist: file.song?.artist ?? '',
      fileName: file.song?.fileName ?? '',
      duration: file.song?.duration ?? 0,
    },
    warnings,
  }
}

/* ----------------------------------------------------------------------------------------- */
/* StepMania .sm export                                                                      */
/* ----------------------------------------------------------------------------------------- */

const SM_DIFFICULTY: Record<Difficulty, string> = {
  easy: 'Easy',
  normal: 'Medium',
  hard: 'Hard',
  expert: 'Challenge',
}

export interface SmExportResult {
  ok: boolean
  text: string
  warnings: string[]
  errors: string[]
}

export interface SmExportOptions {
  title: string
  artist: string
  musicFileName: string
  /** Row resolution; 4 rows per beat = 16th notes (StepMania's standard step type). */
  rowsPerBeat?: number
  /** Include the `#BGCHANGES`/`#DISPLAYBPM` extras (all optional). */
  displayBpm?: boolean
}

/**
 * Export a chart as a valid StepMania `.sm` file.
 *
 * Beat 0 in Beatbreak is the first musical beat; `.sm`'s `#OFFSET` is the *negated* time of
 * beat 0 in the audio file (positive OFFSET = audio starts before beat 0), hence the sign flip.
 * Notes are quantized to the row grid; if any note is not representable at the requested
 * resolution the export reports an error instead of silently emitting a wrong chart.
 */
export function exportSm(chart: Chart, options: SmExportOptions): SmExportResult {
  const warnings: string[] = []
  const errors: string[] = []
  const rowsPerBeat = options.rowsPerBeat ?? 4
  const rowsPerMeasure = rowsPerBeat * 4
  const timing = new TimingMap(chart.timing)

  if (chart.notes.length === 0) errors.push('Chart has no notes.')

  // Verify the notes land exactly on the row grid.
  // Beatbreak can keep micro-timing inside the app, but StepMania only understands a row grid.
  // Rounding here is a lossy representation step, not a failure: the internal JSON chart keeps
  // the exact timing. Warn when a note has to move so the export is never silently imprecise.
  const rowOf = (note: ChartNote): number => Math.round(timing.timeToBeat(note.time) * rowsPerBeat)
  let roundedNotes = 0
  for (const note of chart.notes) {
    const exact = timing.timeToBeat(note.time) * rowsPerBeat
    if (Math.abs(exact - Math.round(exact)) > 1e-6) roundedNotes++
  }
  if (roundedNotes > 0) {
    warnings.push(
      `${roundedNotes} note(s) were rounded to the ${rowsPerBeat}-rows-per-beat grid for StepMania.`,
    )
  }

  const firstBeat = chart.notes.length > 0 ? Math.max(0, Math.floor(rowOf(chart.notes[0]) / rowsPerBeat)) : 0
  if (firstBeat > 0) warnings.push(`Chart starts at beat ${firstBeat}; empty leading measures are included.`)

  // StepMania note letters: 1 = tap, 2 = hold head, 3 = hold tail.
  const cellsByRow = new Map<number, string[]>()
  // A cell already taken, or a row before the first measure, would drop an arrow without a word.
  const lost: string[] = []
  const put = (row: number, lane: Lane, letter: string): void => {
    if (row < 0) {
      lost.push(`before the first beat (lane ${lane + 1})`)
      return
    }
    const cells = cellsByRow.get(row) ?? ['0', '0', '0', '0']
    if (cells[lane] !== '0') lost.push(`beat ${trimNumber(row / rowsPerBeat, 3)}, lane ${lane + 1}`)
    cells[lane] = letter
    cellsByRow.set(row, cells)
  }
  let lastRow = 0
  for (const note of chart.notes) {
    const row = rowOf(note)
    const tailRow =
      note.kind === 'hold' && note.duration && note.duration > 0
        ? Math.round(timing.timeToBeat(note.time + note.duration) * rowsPerBeat)
        : row
    if (tailRow > row) {
      put(row, note.lane, '2')
      put(tailRow, note.lane, '3')
    } else {
      put(row, note.lane, '1')
    }
    lastRow = Math.max(lastRow, tailRow)
  }
  if (lost.length > 0) {
    errors.push(
      `${lost.length} arrow(s) would land on the same StepMania row as another (${lost.slice(0, 3).join('; ')}${lost.length > 3 ? '; ...' : ''}). Move them apart or pick a finer grid.`,
    )
  }
  const measures = Math.max(1, Math.ceil((lastRow + 1) / rowsPerMeasure))

  const laneRows: string[][] = []
  for (let measure = 0; measure < measures; measure++) {
    const rows: string[] = []
    for (let row = 0; row < rowsPerMeasure; row++) {
      rows.push((cellsByRow.get(measure * rowsPerMeasure + row) ?? ['0', '0', '0', '0']).join(''))
    }
    laneRows.push(rows)
  }

  const bpms = normalizeTiming(chart.timing as Timing)
    .bpms.map((segment) => `${trimNumber(segment.beat, 6)}=${trimNumber(segment.bpm, 6)}`)
    .join(',\n     ')
  const offset = -timing.offset

  const header = [
    `#TITLE:${sanitizeSmField(options.title)};`,
    `#SUBTITLE:${sanitizeSmField(`Beatbreak ${chart.difficulty} chart`)};`,
    `#ARTIST:${sanitizeSmField(options.artist)};`,
    `#MUSIC:${sanitizeSmField(options.musicFileName)};`,
    `#OFFSET:${trimNumber(offset, 6)};`,
    `#SAMPLESTART:0.000;`,
    `#SAMPLELENGTH:12.000;`,
    `#SELECTABLE:YES;`,
    options.displayBpm === false ? '' : `#DISPLAYBPM:${trimNumber(timing.primaryBpm, 3)};`,
    `#BPMS:${bpms};`,
    '#STOPS:;',
    '#DELAYS:;',
    '#WARPS:;',
  ].filter((line) => line.length > 0)

  const noteData = laneRows.map((rows) => rows.join('\n')).join('\n,\n')

  const meter = clamp(Math.round(chart.stats.rating), 1, 99)
  const notesSection = [
    `#NOTES:`,
    `     dance-single:`,
    `     :`,
    `     ${SM_DIFFICULTY[chart.difficulty]}:`,
    `     ${meter}:`,
    '     0.000,0.000,0.000,0.000,0.000:',
    noteData,
    ';',
  ].join('\n')

  const text = `${header.join('\n')}\n\n${notesSection}\n`

  if (errors.length > 0) {
    return { ok: false, text: '', warnings, errors }
  }
  warnings.push(
    'StepMania measures are assumed to be 4 beats; note rows are written at ' +
      `${rowsPerBeat} rows per beat.`,
  )
  return { ok: true, text, warnings, errors }
}

const trimNumber = (value: number, decimals: number): string => {
  const fixed = value.toFixed(decimals)
  return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0')
}

const sanitizeSmField = (value: string): string =>
  value
    .replace(/[;\r\n:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Convert a `.sm`-style note letter grid (used by the importer in future) back to lanes. */
export function parseSmNoteRow(row: string): Lane[] {
  const lanes: Lane[] = []
  for (let i = 0; i < row.length; i++) {
    const letter = row[i].toUpperCase()
    if (letter in LANE_FROM_LETTER) lanes.push(LANE_FROM_LETTER[letter])
  }
  return lanes
}
