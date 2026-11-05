/**
 * Which bars of a song are the same music.
 *
 * Human charts repeat their rhythm when the music repeats (84-94% of matching bars share it on
 * the StepMania charts we compare against). A chart picked bar by bar from raw onsets does not:
 * detection noise and vocals move the picks around, so the same riff gets different arrows every
 * time and the chart reads as random. Grouping the bars first lets the generator decide once per
 * group, from what the whole group agrees on.
 */
import type { OnsetEvent, SongTexture } from '../core/types'
import { gridLift } from '../audio/tempo'
import { TimingMap } from './timing'

const BANDS = 4
const SLOW_BPM = 110

/**
 * Bars are always four beats. The analyser's bar guess said three on four of seven songs that are
 * all in four, and a waltz in four-beat bars only loses the grouping, not the notes.
 */
export const BAR_BEATS = 4

/**
 * How alike two bars must be to count as the same music. Tuned on the StepMania songs: bars
 * grouped this way share 64-93% of the human chart's rhythm, against 49-54% for other bars.
 */
const SAME_HITS = 0.3
const SAME_SOUND = 0.75
/** Hits alone are a noisier signal, so without the texture they have to match more closely. */
const SAME_HITS_ALONE = 0.72

export interface BarGroups {
  /** Group of each bar, -1 for a bar with no hits. */
  groupOfBar: number[]
  /** Bars of each group, in time order. */
  members: number[][]
  /** Bars that take the group's arrows left-right flipped. */
  mirrored: boolean[]
}

/** A loop flips sides every this many repeats, so a long run keeps moving without going random. */
const MIRROR_EVERY = 4
/** A group that stays away this many bars starts over: the second chorus matches the first. */
const RUN_BREAK_BARS = 2

function hitMaps(onsets: readonly OnsetEvent[], timing: TimingMap, duration: number): Float32Array[] {
  const slotsPerBeat = timing.primaryBpm < SLOW_BPM ? 8 : 4
  const slots = BAR_BEATS * slotsPerBeat
  const barCount = Math.max(1, Math.ceil(timing.timeToBeat(duration) / BAR_BEATS) + 1)
  const raw = Array.from({ length: barCount }, () => new Float32Array(slots * BANDS))
  const used = new Array<boolean>(barCount).fill(false)
  for (const onset of onsets) {
    const position = Math.round(timing.timeToBeat(onset.time) * slotsPerBeat)
    if (position < 0) continue
    const bar = Math.floor(position / slots)
    if (bar >= barCount) continue
    const band = Math.min(BANDS - 1, Math.max(0, onset.band))
    raw[bar][(position - bar * slots) * BANDS + band] += onset.strength
    used[bar] = true
  }
  // Neighbouring slots share a little weight so a hit detected one slot off still matches.
  return raw.map((map, bar) => {
    if (!used[bar]) return new Float32Array(0)
    const smooth = new Float32Array(map.length)
    for (let slot = 0; slot < slots; slot++) {
      for (let band = 0; band < BANDS; band++) {
        const here = map[slot * BANDS + band]
        const before = slot > 0 ? map[(slot - 1) * BANDS + band] : 0
        const after = slot < slots - 1 ? map[(slot + 1) * BANDS + band] : 0
        smooth[slot * BANDS + band] = here + 0.4 * (before + after)
      }
    }
    return smooth
  })
}

const TEXTURE_SLOTS_PER_BEAT = 4

/** Each bar's sound over time, with the song's average taken out so only differences count. */
function textureMaps(texture: SongTexture, timing: TimingMap, duration: number): Float32Array[] {
  const { rate, bands, data } = texture
  const frames = Math.floor(data.length / bands)
  const slots = BAR_BEATS * TEXTURE_SLOTS_PER_BEAT
  const barCount = Math.max(1, Math.ceil(timing.timeToBeat(duration) / BAR_BEATS) + 1)
  const maps: Float32Array[] = []
  for (let bar = 0; bar < barCount; bar++) {
    const map = new Float32Array(slots * bands)
    for (let slot = 0; slot < slots; slot++) {
      const beat = bar * BAR_BEATS + slot / TEXTURE_SLOTS_PER_BEAT
      const from = Math.round(timing.beatToTime(beat) * rate)
      const to = Math.max(from + 1, Math.round(timing.beatToTime(beat + 1 / TEXTURE_SLOTS_PER_BEAT) * rate))
      for (let band = 0; band < bands; band++) {
        let sum = 0
        let count = 0
        for (let frame = Math.max(0, from); frame < Math.min(frames, to); frame++) {
          sum += data[frame * bands + band]
          count++
        }
        map[slot * bands + band] = count > 0 ? sum / count : 0
      }
    }
    maps.push(map)
  }
  const average = new Float32Array(slots * bands)
  for (const map of maps) for (let i = 0; i < map.length; i++) average[i] += map[i] / maps.length
  const flat = new Float32Array(bands)
  for (let i = 0; i < average.length; i++) flat[i % bands] += average[i] / slots
  for (const map of maps) for (let i = 0; i < map.length; i++) map[i] -= flat[i % bands]
  return maps
}

function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return aa > 0 && bb > 0 ? dot / Math.sqrt(aa * bb) : 0
}

export function groupBars(
  onsets: readonly OnsetEvent[],
  timing: TimingMap,
  duration: number,
  texture?: SongTexture,
): BarGroups {
  const maps = hitMaps(onsets, timing, duration)
  const sounds = texture ? textureMaps(texture, timing, duration) : null
  const sameHits = sounds ? SAME_HITS : SAME_HITS_ALONE
  const groupOfBar = new Array<number>(maps.length).fill(-1)
  const centres: { hits: Float32Array; sound: Float32Array | null }[] = []

  const nearest = (bar: number): number => {
    let group = -1
    let best = -1
    centres.forEach((centre, index) => {
      const hits = similarity(maps[bar], centre.hits)
      const sound = sounds && centre.sound ? similarity(sounds[bar], centre.sound) : 1
      if (hits < sameHits || sound < SAME_SOUND) return
      const score = hits + sound
      if (score > best) {
        best = score
        group = index
      }
    })
    return group
  }

  maps.forEach((map, bar) => {
    if (map.length === 0) return
    const group = nearest(bar)
    if (group >= 0) {
      groupOfBar[bar] = group
      const centre = centres[group]
      for (let i = 0; i < map.length; i++) centre.hits[i] += map[i]
      if (sounds && centre.sound) for (let i = 0; i < centre.sound.length; i++) centre.sound[i] += sounds[bar][i]
    } else {
      groupOfBar[bar] = centres.length
      centres.push({ hits: map.slice(), sound: sounds ? sounds[bar].slice() : null })
    }
  })

  // One more pass: an early bar joined the group as it looked then, not as it ended up.
  const settled = maps.map((map, bar) => {
    if (map.length === 0) return -1
    const group = nearest(bar)
    return group >= 0 ? group : groupOfBar[bar]
  })
  const renumber = new Map<number, number>()
  const members: number[][] = []
  const final = settled.map((group, bar) => {
    if (group < 0) return -1
    if (!renumber.has(group)) {
      renumber.set(group, members.length)
      members.push([])
    }
    const id = renumber.get(group)!
    members[id].push(bar)
    return id
  })
  const mirrored = new Array<boolean>(final.length).fill(false)
  for (const bars of members) {
    let repeats = 0
    bars.forEach((bar, index) => {
      repeats = index > 0 && bar - bars[index - 1] > RUN_BREAK_BARS + 1 ? 0 : repeats
      mirrored[bar] = Math.floor(repeats / MIRROR_EVERY) % 2 === 1
      repeats++
    })
  }
  return { groupOfBar: final, members, mirrored }
}

/** Above this share of repeating bars the detected tempo is left alone. */
const CLEAR_REPEATS = 0.6
/** A new tempo has to make this much more of the song repeat. */
const REPEATS_GAIN = 0.2
/** Tempos this close to the best are the same family (double, half, three-to-two). */
const REPEATS_TIE = 0.1
/** Between tied tempos a grid fit has to be this much better to beat the slower one. */
const LIFT_TIE = 1.05

function repeatShare(onsets: readonly OnsetEvent[], texture: SongTexture, seconds: number, bpm: number, offset: number): number {
  const { members, groupOfBar } = groupBars(onsets, TimingMap.single(bpm, offset), seconds, texture)
  const bars = groupOfBar.filter((group) => group >= 0).length
  if (bars === 0) return 0
  return members.reduce((acc, group) => acc + (group.length > 1 ? group.length : 0), 0) / bars
}

/**
 * Music repeats at the bar, so the right tempo is the one that makes the bars repeat. Onset fits
 * alone landed on made-up tempos near 120 on five of 25 songs, with almost no bar matching any
 * other and the whole grid wrong; a scan of the bars found round tempos instead (What You Know
 * Bout Love went from 110.5 to 84). Returns a better tempo, or null when the current one is fine.
 */
export function tempoFromRepeats(
  onsets: readonly OnsetEvent[],
  texture: SongTexture,
  duration: number,
  currentBpm: number,
  currentOffset: number,
): number | null {
  if (onsets.length < 24) return null
  const current = repeatShare(onsets, texture, duration, currentBpm, currentOffset)
  if (current >= CLEAR_REPEATS) return null

  const rows: { bpm: number; share: number }[] = []
  for (let bpm = 70; bpm <= 200; bpm += 0.5) {
    rows.push({ bpm, share: repeatShare(onsets, texture, duration, bpm, 0) })
  }
  const best = rows.reduce((a, b) => (b.share > a.share ? b : a))
  if (best.share < current + REPEATS_GAIN) return null

  const strong = onsets.filter((onset) => onset.strength >= 0.3)
  let pick = { bpm: 0, lift: 0 }
  for (const row of rows.filter((entry) => entry.share >= best.share - REPEATS_TIE)) {
    const lift = gridLift(row.bpm, strong)
    if (lift > pick.lift * LIFT_TIE) pick = { bpm: row.bpm, lift }
  }
  return pick.bpm
}
