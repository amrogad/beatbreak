/**
 * Canvas playfield renderer.
 *
 * Contract with the rest of the game:
 *  - It never reads the clock itself and never decides anything about judgement. The caller
 *    passes the audible song time (milliseconds) every frame, and the renderer draws the world
 *    for that instant.
 *  - It reads pending notes through `GameSession.forEachPending`, so judged notes disappear the
 *    moment they are judged and drawing stays O(visible notes).
 *  - Everything decorative (background motion, beat pulses, explosions, particles) is skipped when
 *    reduced motion is on, and thinned out by the adaptive quality level on slow machines.
 *
 * Arrows, receptors and glows are traced once per size and colour into small offscreen sprites, so
 * a frame is mostly `drawImage` calls.
 */
import type { Chart, ChartNote, HitEvent, Judgment, Lane } from '../core/types'
import { TimingMap } from '../chart/timing'
import { JUDGMENT_LABEL } from '../game/judgment'
import type { GameSession } from '../game/session'
import { ParticleSystem } from './particles'

export type LaneStyle = 'neon' | 'classic' | 'minimal'
/** Note skin: the thick default arrow, a vector chevron, a diamond, or a plain bar. */
export type NoteShape = 'arrow' | 'chevron' | 'diamond' | 'orb' | 'star' | 'hex' | 'bar' | 'tile' | 'square'
/** 'up' = arcade layout (targets at the top, arrows rise); 'down' = classic falling arrows. */
export type ScrollDirection = 'up' | 'down'
/** Whole-app skin: the colour arcade, or a pitch-black room lit only in white. */
export type ThemeName = 'neon' | 'disco' | 'mono'
/** Arrow colours: one fixed colour per column, or a fresh random set every song. */
export type ArrowColors = 'column' | 'random'

export interface RenderSettings {
  /** 1 (slow) … 10 (fast). Converted to pixels per second using the travel distance. */
  scrollSpeed: number
  /** One multiplier for tap notes, hold notes and receptors, 0.6…1.3 (1 = default size). */
  noteScale: number
  /** How much the background moves: full show, calmer, or a still backdrop. */
  laneStyle: LaneStyle
  noteShape: NoteShape
  scrollDirection: ScrollDirection
  theme: ThemeName
  arrowColors: ArrowColors
  /** Draw an end arrow on holds (let go there) or a plain rounded end (just hold to the end). */
  holdEndArrow?: boolean
  /** Where song progress shows: a line across the top, a bar under the title, or text under accuracy. */
  progressStyle?: 'top' | 'column' | 'text'
  /** The four column colours the player picked (used when arrow colours are per column). */
  columnColors: string[]
  reducedMotion: boolean
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  scrollSpeed: 5,
  noteScale: 1,
  laneStyle: 'neon',
  noteShape: 'arrow',
  scrollDirection: 'up',
  theme: 'disco',
  arrowColors: 'column',
  columnColors: ['#ff4f9a', '#3d9bff', '#3fe08a', '#ffc93d'],
  reducedMotion: false,
}

export interface HudState {
  score: number
  combo: number
  accuracy: number
  /** 0..1 */
  progress: number
  countdownMs: number | null
  paused: boolean
  autoPlay: boolean
  /** Draw the frame-rate / quality readout (Settings → Show statistics). */
  showStats: boolean
  title?: string
  subtitle?: string
  /** Colour of the subtitle: the chosen difficulty's own colour. */
  subtitleColor?: string
}

interface PlayfieldPalette {
  skyTop: string
  skyBottom: string
  lanePanel: string
  hudText: string
  hudMuted: string
  accent: string
  accent2: string
}

const PALETTES: Record<ThemeName, PlayfieldPalette> = {
  neon: {
    skyTop: '#0b1430',
    skyBottom: '#03050d',
    lanePanel: 'rgba(3, 6, 16, 0.62)',
    hudText: '#ffffff',
    hudMuted: '#a9bbe0',
    accent: '#3be8ff',
    accent2: '#7c5cff',
  },
  disco: {
    skyTop: '#221a52',
    skyBottom: '#0e0a24',
    lanePanel: 'rgba(10, 7, 28, 0.66)',
    hudText: '#f6f3ff',
    hudMuted: '#b8b0e0',
    accent: '#b35cff',
    accent2: '#ffd23d',
  },
  mono: {
    skyTop: '#000000',
    skyBottom: '#000000',
    lanePanel: 'rgba(0, 0, 0, 0.72)',
    hudText: '#ffffff',
    hudMuted: '#9a9a9a',
    accent: '#ffffff',
    accent2: '#ffffff',
  },
}

/** Each column's own colour: arrows, the target rim, its press glow and its lane beam. */
export const COLUMN_COLORS = ['#ff4f9a', '#3d9bff', '#3fe08a', '#ffc93d']
/** Picked from at random, four at a time, when arrow colours are shuffled. */
const SHUFFLE_COLORS = ['#ff4f9a', '#3d9bff', '#3fe08a', '#ffc93d', '#b35cff', '#ff7a3d', '#3de9ff', '#9dff3d']
const MONO_WHITE = '#f4f4f4'
/** A missed arrow turns this red and fades out where it was missed, over this long. */
const MISS_COLOR = '#ff4d5e'
const MISS_FADE_MS = 320
/** An early or late hit fades out where it was tapped, over this long. */
const HIT_FADE_MS = 160
/** An unhit note starts turning red this late (past Perfect) and is fully red this much later. */
const LATE_RED_FROM_MS = 30
const LATE_RED_MS = 50

interface JudgeStyle {
  fill: string
  /** Hard drop shadow under the letters, and the colour of the hit explosion. */
  shadow: string
  burst: string
}

const MONO_JUDGE: JudgeStyle = { fill: '#ffffff', shadow: '#3a3a3a', burst: '#ffffff' }

/** Judgment colours come from the same palette as the arrows. */
const JUDGE_STYLE: Record<Judgment, JudgeStyle> = {
  marvelous: { fill: '#3de9ff', shadow: '#13708a', burst: '#3de9ff' },
  perfect: { fill: '#ffc93d', shadow: '#8a5a06', burst: '#ffc93d' },
  great: { fill: '#3fe08a', shadow: '#127040', burst: '#3fe08a' },
  good: { fill: '#b35cff', shadow: '#55208a', burst: '#b35cff' },
  miss: { fill: '#ff4f9a', shadow: '#8a1648', burst: '#ff4f9a' },
}

interface JudgmentFlash {
  judgment: Judgment
  lane: Lane
  deltaMs: number
  ageMs: number
  /** The miss is a hold LetGo: print LET GO instead of MISS. */
  holdDrop?: boolean
}

/** Resolved lane geometry; recomputed only when the canvas or the layout settings change. */
interface PlayfieldLayout {
  laneW: number
  laneX: number[]
  laneAreaX: number
  laneAreaW: number
  receptorY: number
  /** Side of the square arrow tile. */
  noteH: number
  pxPerSec: number
  travelSeconds: number
  /** +1 when arrows rise (targets at the top), -1 when they fall (targets at the bottom). */
  direction: 1 | -1
}

/** Pixels per second for a scroll-speed setting, given the distance notes travel. */
export function scrollPixelsPerSecond(speed: number, travelDistance: number): number {
  const clamped = Math.max(1, Math.min(10, speed))
  // At speed 5 a 700 px tall playfield scrolls at ~830 px/s (≈0.85 s of lookahead) — a familiar
  // StepMania-ish reading speed. Slower settings scale linearly below that.
  const reference = 140 + clamped * 138
  const referenceDistance = 700
  return reference * (travelDistance / referenceDistance)
}

/** Arcade marquee face for big numbers and judgments; a condensed sans for small labels. */
const DISPLAY = 'Bungee, "Segoe UI", Arial, sans-serif'
const FONT = 'Barlow, "Segoe UI", Arial, sans-serif'

/** Rotation (radians) that turns a right-pointing arrow into each lane's direction. */
const LANE_ANGLE = [Math.PI, Math.PI / 2, -Math.PI / 2, 0]

export class PlayfieldRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private settings: RenderSettings
  private particles = new ParticleSystem()
  private timing = TimingMap.single(120, 0)
  private columnColors = [...COLUMN_COLORS]
  /** The two side rails take two of the column colours, picked fresh for every song. */
  private railColors = [COLUMN_COLORS[0], COLUMN_COLORS[3]]
  private width = 0
  private height = 0
  private dpr = 1
  private lastFrameMs = 0
  private nowMs = 0

  /* Per-lane animation state, all in wall-clock milliseconds. */
  private laneHeld = [false, false, false, false]
  private pressAt = [-1e9, -1e9, -1e9, -1e9]
  private releaseAt = [-1e9, -1e9, -1e9, -1e9]
  private explosion: ({ color: string; at: number } | null)[] = [null, null, null, null]
  private flash: JudgmentFlash | null = null
  /** Notes by id, so a missed one can be drawn fading where it was missed. */
  private notesById = new Map<string, ChartNote>()
  /** Seconds from each note to the next one in its column, for trimming piano tiles that would overlap. */
  private laneGap = new Map<string, number>()
  /** Half the tile's width in the same units; the short home preview shrinks notes but not columns. */
  private tileHx = TILE_BASE_HX
  /**
   * Missed arrows fading out on the spot: the note, the song time it froze at, where its head
   * sat (a hold let go late keeps its played part out of view) and the wall-clock start.
   */
  private missFx: { note: ChartNote; frozenMs: number; headTime: number; at: number; hit?: boolean }[] = []
  private lastCombo = 0
  private comboBumpAt = -1e9
  private comboMilestoneAt = -1e9

  /* ------------------------------------------------------------------ caches
   * Everything below is rebuilt lazily and only when the geometry or the skin changes, so the
   * steady-state per-frame cost is drawing, not allocating. */
  private layoutCache: PlayfieldLayout | null = null
  private layoutKey = ''
  private spriteCache = new Map<string, HTMLCanvasElement>()
  private skyCache: { key: string; gradient: CanvasGradient } | null = null
  private vignetteCache: { key: string; gradient: CanvasGradient } | null = null
  /** Mirror-ball light flecks: position on the ball, height on the wall, size and tint. */
  private flecks = Array.from({ length: 70 }, () => ({
    angle: Math.random() * Math.PI * 2,
    height: Math.random(),
    size: Math.random(),
    hueOffset: Math.random() * 90,
  }))
  private scoreTextCache = { value: -1, text: '' }
  private accuracyTextCache = { value: -1, text: '' }
  private titleCache = { key: '', text: '' }
  private spritesWarm = false
  private textCache = new Map<string, { canvas: HTMLCanvasElement; w: number; h: number }>()

  /* ------------------------------------------------------------- self-tuning
   * The renderer watches its own frame time and sheds decoration when the machine cannot hold a
   * comfortable frame rate. Quality only ever affects what things look like, never what happens:
   * judgement and scoring never touch the renderer. */
  private frameEma = 16.7
  private qualityTimer = 0
  /** 2 = full, 1 = reduced, 0 = minimal. */
  private quality: 0 | 1 | 2 = 2

  /** A small demo playfield (the home page): lanes fill the canvas and there is no HUD. */
  private preview: boolean

  constructor(canvas: HTMLCanvasElement, settings: RenderSettings = DEFAULT_RENDER_SETTINGS, options: { preview?: boolean } = {}) {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas 2D is not available in this browser.')
    this.canvas = canvas
    this.ctx = ctx
    this.settings = { ...settings }
    this.preview = options.preview ?? false
  }

  setSettings(settings: Partial<RenderSettings>): void {
    this.settings = { ...this.settings, ...settings }
    this.invalidateCaches()
  }

  getSettings(): RenderSettings {
    return { ...this.settings }
  }

  /** Clear transient effects so nothing leaks between runs, and colour the chart's arrows. */
  setChart(durationSeconds: number, chart?: Pick<Chart, 'notes' | 'timing'>): void {
    void durationSeconds
    this.particles.clear()
    this.flash = null
    this.laneHeld = [false, false, false, false]
    this.explosion = [null, null, null, null]
    this.lastCombo = 0
    this.missFx = []
    this.notesById.clear()
    this.columnColors =
      this.settings.arrowColors === 'random' ? shuffledColors() : validColors(this.settings.columnColors)
    const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5)
    this.railColors = [this.columnColors[order[0]], this.columnColors[order[1]]]
    this.spritesWarm = false
    if (!chart) return
    this.timing = new TimingMap(chart.timing)
    for (const note of chart.notes) {
      this.notesById.set(note.id, note)
    }
    this.laneGap = laneGaps(chart.notes)
    this.layoutCache = null
    this.layoutKey = ''
  }

  /**
   * Build every arrow, target, flash and glow sprite the run will use before it starts. Each one
   * is a canvas drawn with blurs; building them lazily put a hitch on the first arrows.
   */
  private warmSprites(): void {
    const { noteH } = this.layout()
    for (let lane = 0; lane < 4; lane++) {
      const color = this.columnColor(lane)
      this.noteSprite('note', color, lane as Lane, noteH)
      this.noteSprite('note', this.missColor(), lane as Lane, noteH)
      const bar = this.settings.noteShape === 'tile' ? TILE_BAR_HY : undefined
      this.noteSprite('receptor', color, lane as Lane, noteH, bar)
      this.noteSprite('flash', color, lane as Lane, noteH, bar)
      this.noteSprite('flash', '#ffffff', lane as Lane, noteH, bar)
      this.glowSprite(color, Math.round(noteH))
    }
    this.glowSprite('#ffffff', Math.round(noteH))
    // Tiles cut shorter for tight spots: build each size the chart uses before it starts.
    if (this.settings.noteShape === 'tile') {
      for (const note of this.notesById.values()) {
        const hy = this.tileHyFor(note)
        this.noteSprite('note', this.columnColor(note.lane), note.lane, noteH, hy)
        this.noteSprite('note', this.missColor(), note.lane, noteH, hy)
      }
    }
    this.spritesWarm = true
  }

  /** Which column a screen x position (CSS pixels from the canvas's left edge) falls in. */
  laneAt(x: number): Lane | null {
    const { laneAreaX, laneAreaW } = this.layout()
    // A little slack outside the outer columns so a thumb on the edge still counts.
    const slack = laneAreaW * 0.12
    if (x < laneAreaX - slack || x > laneAreaX + laneAreaW + slack) return null
    const lane = Math.floor(((x - laneAreaX) / laneAreaW) * 4)
    return Math.max(0, Math.min(3, lane)) as Lane
  }

  /** The colour every arrow, target and glow in a column uses. */
  private columnColor(lane: number): string {
    return this.settings.theme === 'mono' ? MONO_WHITE : this.columnColors[lane]
  }

  private judgeStyle(judgment: Judgment): JudgeStyle {
    return this.settings.theme === 'mono' ? MONO_JUDGE : JUDGE_STYLE[judgment]
  }

  press(lane: Lane): void {
    this.laneHeld[lane] = true
    this.pressAt[lane] = performance.now()
  }

  release(lane: Lane): void {
    if (!this.laneHeld[lane]) return
    this.laneHeld[lane] = false
    this.releaseAt[lane] = performance.now()
  }

  /** A judgement happened: judgment text, an explosion on the receptor and a spark burst. */
  notify(event: HitEvent, combo: number): void {
    void combo
    const { lane, judgment } = event
    this.flash = { judgment, lane, deltaMs: event.deltaMs, ageMs: 0, ...(event.holdDrop ? { holdDrop: true } : {}) }
    if (judgment === 'miss') {
      // A miss turns red and fades out where it happened instead of scrolling away (Amro's pick).
      const note = this.notesById.get(event.noteId.replace(/#tail$/, ''))
      if (note) {
        const headTime = event.noteId.endsWith('#tail') ? Math.max(note.time, event.time) : note.time
        this.missFx.push({ note, frozenMs: event.time * 1000, headTime, at: performance.now() })
      }
      return
    }
    const color = this.columnColor(lane)
    this.explosion[lane] = { color, at: performance.now() }
    // An early or late tap shows the note vanishing where it really was, short of or past the target.
    const hitNote = Math.abs(event.deltaMs) > 20 && !event.noteId.endsWith('#tail') ? this.notesById.get(event.noteId) : undefined
    if (hitNote && hitNote.kind === 'tap') {
      this.missFx.push({ note: hitNote, frozenMs: event.time * 1000, headTime: hitNote.time, at: performance.now(), hit: true })
    }
    if (this.settings.reducedMotion) return
    const geometry = this.layout()
    const x = geometry.laneX[lane] + geometry.laneW / 2
    // Particle count follows the adaptive quality level; at minimal it spawns none at all.
    const density = this.quality === 2 ? 1 : this.quality === 1 ? 0.6 : 0
    if (density <= 0) return
    const strength = judgment === 'marvelous' ? 1.4 : judgment === 'perfect' ? 1.25 : judgment === 'great' ? 1 : 0.8
    const count = judgment === 'marvelous' || judgment === 'perfect' ? 12 : judgment === 'great' ? 8 : 5
    this.particles.burst(x, geometry.receptorY, color, { count: Math.round(count * density), strength })
  }

  /** A hold reached its tail with the key still down: StepMania's OK. */
  holdComplete(lane: Lane): void {
    this.explosion[lane] = { color: '#ffffff', at: performance.now() }
    if (this.settings.reducedMotion || this.quality === 0) return
    const geometry = this.layout()
    this.particles.burst(geometry.laneX[lane] + geometry.laneW / 2, geometry.receptorY, '#ffffff', { count: 10, strength: 1.1 })
  }

  resize(): { width: number; height: number } {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2.5))
    const width = Math.max(1, Math.round(rect.width))
    const height = Math.max(1, Math.round(rect.height))
    const changed =
      this.dpr !== dpr || this.width !== width || this.height !== height ||
      this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)
    if (changed) {
      this.canvas.width = Math.round(width * dpr)
      this.canvas.height = Math.round(height * dpr)
      this.dpr = dpr
      this.width = width
      this.height = height
      this.invalidateCaches()
    }
    return { width, height }
  }

  /** Drop every cached drawing resource; the next frame rebuilds exactly what it needs. */
  private invalidateCaches(): void {
    this.layoutCache = null
    this.layoutKey = ''
    this.spriteCache.clear()
    this.textCache.clear()
    this.spritesWarm = false
    this.skyCache = null
    this.vignetteCache = null
  }

  private layout(): PlayfieldLayout {
    // Leave room for touch thumbs and for wide monitors: the playfield is a centred column.
    const key = `${this.width}x${this.height}:${this.dpr}:${this.settings.scrollSpeed}:${this.settings.noteScale}:${this.settings.scrollDirection}:${this.settings.noteShape}`
    const cached = this.layoutCache
    if (cached && this.layoutKey === key) return cached
    // Phones use nearly the full width: thumbs need big targets more than they need margins.
    const laneAreaW = this.preview
      ? this.width * 0.84
      : this.width < 600
        ? this.width * 0.92
        : Math.max(180, Math.min(this.width * 0.72, 460))
    const laneW = laneAreaW / 4
    const laneAreaX = (this.width - laneAreaW) / 2
    const direction: 1 | -1 = this.settings.scrollDirection === 'down' ? -1 : 1
    const fullNote = Math.min(laneW * 0.96, laneW * 0.86 * this.settings.noteScale)
    // A short preview canvas keeps the arrows in proportion to its height.
    const noteH = this.preview ? Math.min(fullNote, this.height * 0.2) : fullNote
    // The receptor inset mirrors between layouts: at the top for rising arrows, at the bottom
    // for falling ones, so touch-thumb room and HUD clearance are the same either way.
    const inset = this.preview ? noteH * (this.settings.noteShape === 'tile' ? 0.5 : 0.8) : Math.max(96, Math.min(this.height * 0.16, 150), 64 + noteH / 2)
    const receptorY = direction === 1 ? inset : this.height - inset
    const travelDistance = direction === 1 ? this.height - receptorY : receptorY
    const pxPerSec = scrollPixelsPerSecond(this.settings.scrollSpeed, travelDistance)
    const layout: PlayfieldLayout = {
      laneW,
      laneX: [0, 1, 2, 3].map((i) => laneAreaX + i * laneW),
      laneAreaX,
      laneAreaW,
      receptorY,
      noteH,
      pxPerSec,
      travelSeconds: (travelDistance + noteH) / Math.max(1, pxPerSec),
      direction,
    }
    this.tileHx = Math.round(((TILE_BASE_HX * fullNote) / Math.max(1, noteH)) * 20) / 20
    this.layoutCache = layout
    this.layoutKey = key
    return layout
  }

  /* ------------------------------------------------------------------ frame */

  render(session: GameSession, songTimeMs: number, hud: HudState): void {
    const ctx = this.ctx
    // The backing store is devicePixelRatio-scaled; draw in logical pixels. Setting the transform
    // every frame is a no-op for canvas cost and guarantees correctness after a resize (which
    // resets the transform). Without this, the playfield is cropped/zoomed on HiDPI displays.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const now = performance.now()
    const dtMs = this.lastFrameMs === 0 ? 16 : Math.min(now - this.lastFrameMs, 80)
    this.lastFrameMs = now
    this.nowMs = now
    const reduced = this.settings.reducedMotion

    // Adaptive quality: a slow machine loses decoration, never gameplay. The thresholds have
    // hysteresis (degrade above 21.5 ms, recover below 15 ms average) and 1 s dwell time, so a
    // single hitch cannot flip the level back and forth.
    this.frameEma += (dtMs - this.frameEma) * 0.06
    this.qualityTimer += dtMs
    if (this.qualityTimer >= 1000) {
      this.qualityTimer = 0
      if (this.frameEma > 21.5 && this.quality > 0) this.quality = (this.quality - 1) as 0 | 1 | 2
      else if (this.frameEma < 15 && this.quality < 2) this.quality = (this.quality + 1) as 0 | 1 | 2
    }

    if (this.flash) {
      this.flash.ageMs += dtMs
      if (this.flash.ageMs > 900) this.flash = null
    }
    if (hud.combo !== this.lastCombo) {
      if (hud.combo > this.lastCombo) this.comboBumpAt = now
      if (Math.floor(hud.combo / 50) > Math.floor(this.lastCombo / 50) && hud.combo >= 50) this.comboMilestoneAt = now
      this.lastCombo = hud.combo
    }
    if (!reduced && this.quality > 0) this.particles.update(dtMs)

    if (!this.spritesWarm) this.warmSprites()
    const songSeconds = songTimeMs / 1000
    const beat = this.timing.timeToBeat(songSeconds)
    const beatFrac = beat - Math.floor(beat)

    this.drawBackground(songSeconds)
    this.drawLanes()
    this.drawReceptors()
    this.drawNotes(session, songTimeMs)
    this.drawExplosions()
    if (!reduced && this.quality > 0) this.particles.draw(ctx)
    this.drawJudgmentFlash()
    this.drawCombo(hud)
    if (this.preview) return
    this.drawHud(hud)
    this.drawCountdown(hud)
  }

  /* ------------------------------------------------------------- background */

  private drawBackground(songSeconds: number): void {
    const ctx = this.ctx
    const palette = PALETTES[this.settings.theme]
    const skyKey = `${this.width}x${this.height}:${this.settings.theme}`
    if (!this.skyCache || this.skyCache.key !== skyKey) {
      const gradient = ctx.createLinearGradient(0, 0, 0, this.height)
      gradient.addColorStop(0, palette.skyTop)
      gradient.addColorStop(1, palette.skyBottom)
      this.skyCache = { key: skyKey, gradient }
    }
    ctx.fillStyle = this.skyCache.gradient
    ctx.fillRect(0, 0, this.width, this.height)

    const style = this.settings.laneStyle
    if (style === 'minimal' || this.settings.reducedMotion || this.quality === 0) return

    const w = this.width
    const h = this.height
    const hue = (((songSeconds * 6) % 360) + 360) % 360
    const sat = this.settings.theme === 'mono' ? 0 : 90

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'

    // A wash of colour that swells on every beat and drifts around the colour wheel.
    const glow = ctx.createRadialGradient(w / 2, h * 0.62, 0, w / 2, h * 0.62, Math.max(w, h) * 0.75)
    glow.addColorStop(0, `hsla(${hue}, ${sat}%, ${sat ? 55 : 80}%, 0.06)`)
    glow.addColorStop(0.55, `hsla(${(hue + 60) % 360}, ${sat}%, ${sat ? 50 : 75}%, 0.025)`)
    glow.addColorStop(1, 'hsla(0, 0%, 0%, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, w, h)

    if (style === 'neon' && this.quality === 2) {
      // Two sweeping stage lights from the top corners.
      for (let i = 0; i < 2; i++) {
        const originX = i === 0 ? w * 0.08 : w * 0.92
        const angle = Math.PI / 2 + Math.sin(songSeconds * 0.7 + i * 2.1) * 0.55 + (i === 0 ? -0.35 : 0.35)
        const length = h * 1.3
        const spread = 0.16
        const lightHue = (hue + (i === 0 ? 0 : 160)) % 360
        const tipX1 = originX + Math.cos(angle - spread) * length
        const tipY1 = Math.sin(angle - spread) * length
        const tipX2 = originX + Math.cos(angle + spread) * length
        const tipY2 = Math.sin(angle + spread) * length
        const beam = ctx.createLinearGradient(originX, 0, (tipX1 + tipX2) / 2, (tipY1 + tipY2) / 2)
        beam.addColorStop(0, `hsla(${lightHue}, ${sat ? 100 : 0}%, ${sat ? 70 : 92}%, ${sat ? 0.045 : 0.06})`)
        beam.addColorStop(1, 'hsla(0, 0%, 0%, 0)')
        ctx.fillStyle = beam
        ctx.beginPath()
        ctx.moveTo(originX, -10)
        ctx.lineTo(tipX1, tipY1)
        ctx.lineTo(tipX2, tipY2)
        ctx.closePath()
        ctx.fill()
      }

    }

    // Mirror-ball light: small flecks sweep slowly across the walls as an unseen ball turns.
    // A fleck is brightest while it faces the room and fades as it turns away.
    const turn = songSeconds * 0.07
    for (const fleck of this.flecks) {
      const angle = fleck.angle + turn
      const facing = Math.cos(angle)
      if (facing <= 0.05) continue
      const x = w / 2 + Math.sin(angle) * w * 0.62
      const y = fleck.height * h
      const size = (2 + fleck.size * 3) * (0.6 + 0.4 * facing)
      ctx.globalAlpha = facing * (0.35 + 0.25 * fleck.size)
      ctx.fillStyle = sat ? `hsl(${(hue + fleck.hueOffset) % 360}, 90%, 72%)` : '#ffffff'
      ctx.fillRect(x - size, y - size * 0.6, size * 2, size * 1.2)
    }
    ctx.restore()

    // Darken the edges so the light fades toward the corners.
    const vignetteKey = `${w}x${h}:${palette.skyBottom}`
    if (!this.vignetteCache || this.vignetteCache.key !== vignetteKey) {
      const vignette = ctx.createRadialGradient(w / 2, h * 0.55, Math.min(w, h) * 0.2, w / 2, h * 0.55, Math.max(w, h) * 0.75)
      vignette.addColorStop(0, hexToRgba(palette.skyBottom, 0))
      vignette.addColorStop(1, hexToRgba(palette.skyBottom, 0.92))
      this.vignetteCache = { key: vignetteKey, gradient: vignette }
    }
    ctx.fillStyle = this.vignetteCache.gradient
    ctx.fillRect(0, 0, w, h)
  }

  private drawLanes(): void {
    const ctx = this.ctx
    const palette = PALETTES[this.settings.theme]
    const { laneX, laneW, laneAreaX, laneAreaW } = this.layout()
    // The highway is a little wider than the lanes, so the outer arrows do not touch the rails.
    const gap = Math.max(8, laneW * 0.1)
    ctx.fillStyle = palette.lanePanel
    ctx.fillRect(laneAreaX - gap, 0, laneAreaW + gap * 2, this.height)
    if (this.settings.laneStyle === 'classic') {
      for (let lane = 1; lane < 4; lane += 2) {
        ctx.fillStyle = 'rgba(255,255,255,0.025)'
        ctx.fillRect(laneX[lane], 0, laneW, this.height)
      }
    }
    for (let lane = 1; lane < 4; lane++) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)'
      ctx.fillRect(laneX[lane], 0, 1, this.height)
    }
    // Neon edge rails, glowing in their colour.
    // The halo is a plain horizontal gradient: a full-height shadow blur costs too much per frame.
    const rail = (x: number, color: string): void => {
      if (this.quality > 0) {
        const halo = ctx.createLinearGradient(x - 10, 0, x + 12, 0)
        halo.addColorStop(0, hexToRgba(color, 0))
        halo.addColorStop(0.5, hexToRgba(color, 0.35))
        halo.addColorStop(1, hexToRgba(color, 0))
        ctx.fillStyle = halo
        ctx.fillRect(x - 10, 0, 22, this.height)
      }
      ctx.fillStyle = hexToRgba(color, 0.9)
      ctx.fillRect(x, 0, 2, this.height)
    }
    const mono = this.settings.theme === 'mono'
    rail(laneAreaX - gap - 2, mono ? palette.accent : this.railColors[0])
    rail(laneAreaX + laneAreaW + gap, mono ? palette.accent2 : this.railColors[1])
  }

  /* ---------------------------------------------------------------- notes */

  private drawReceptors(): void {
    const ctx = this.ctx
    const { laneX, laneW, receptorY, noteH } = this.layout()
    for (let lane = 0; lane < 4; lane++) {
      const x = laneX[lane] + laneW / 2
      // StepMania's receptor: brightens on each beat, dips to 85% when pressed and springs back.
      const sincePress = this.nowMs - this.pressAt[lane]
      const squash = sincePress < 110 ? 0.85 + 0.15 * (sincePress / 110) : 1
      const size = noteH * squash
      const tiles = this.settings.noteShape === 'tile'
      const sprite = this.noteSprite('receptor', this.columnColor(lane), lane as Lane, noteH, tiles ? TILE_BAR_HY : undefined)
      // A tile's target is a bar its front edge lands on, sitting just past the hit line.
      const targetY = tiles ? receptorY - this.tileShift(TILE_BAR_HY) : receptorY
      ctx.globalAlpha = 0.9
      drawCentered(ctx, sprite, x, targetY, size)
      ctx.globalAlpha = 1

      // The press overlay: a bright copy that settles at 40% while held and swells away on release.
      let overlay = 0
      let zoom = 1
      if (this.laneHeld[lane]) {
        overlay = sincePress < 200 ? 0.8 - 0.25 * (sincePress / 200) : 0.55
      } else {
        const sinceRelease = this.nowMs - this.releaseAt[lane]
        if (sinceRelease < 200) {
          const t = sinceRelease / 200
          overlay = 0.55 * (1 - t)
          zoom = 1 + 0.1 * t
        }
      }
      if (overlay > 0) {
        const flash = this.noteSprite('flash', this.columnColor(lane), lane as Lane, noteH, tiles ? TILE_BAR_HY : undefined)
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = overlay
        drawCentered(ctx, flash, x, targetY, size * zoom)
        ctx.restore()
      }
    }
  }

  private drawNotes(session: GameSession, songTimeMs: number): void {
    const ctx = this.ctx
    const { laneX, laneW, receptorY, noteH, pxPerSec, travelSeconds, direction } = this.layout()
    const untilMs = songTimeMs + travelSeconds * 1000
    const reduced = this.settings.reducedMotion

    // Holds already being played: the head stays pinned on the receptor while the body drains.
    session.forEachActiveHold(songTimeMs, (note, life) => {
      const duration = note.duration ?? 0
      if (duration <= 0.05) return
      const tailDeltaMs = (note.time + duration) * 1000 - songTimeMs
      if (tailDeltaMs < 0) return
      const x = laneX[note.lane] + laneW / 2
      const shift = this.tileShift(TILE_HY)
      const headY = receptorY + shift
      const tailY = receptorY + direction * (tailDeltaMs / 1000) * pxPerSec + shift
      const color = this.columnColor(note.lane)
      const held = life >= 1
      this.drawHoldBody(x, headY, tailY, noteH, color, held ? 'active' : 'dropping', life, note.lane)
      this.drawHoldEnd(x, tailY, noteH, color, note.lane)
      const sprite = this.noteSprite('note', color, note.lane, noteH, TILE_HY)
      ctx.globalAlpha = held ? 1 : 0.45 + 0.55 * life
      drawCentered(ctx, sprite, x, headY, noteH)
      ctx.globalAlpha = 1
      if (held && !reduced && this.quality > 0) this.drawHoldGlow(x, receptorY, noteH, color)
    })

    this.missFx = this.missFx.filter((fx) => {
      const age = this.nowMs - fx.at
      const life = fx.hit ? HIT_FADE_MS : MISS_FADE_MS
      if (age > life) return false
      const fade = 1 - age / life
      const { note } = fx
      const x = laneX[note.lane] + laneW / 2
      const hy = this.tileHyFor(note)
      const shift = this.tileShift(hy)
      const headY = receptorY + direction * ((fx.headTime * 1000 - fx.frozenMs) / 1000) * pxPerSec + shift
      const size = noteH * (1 - 0.12 * (1 - fade))
      const missColor = fx.hit ? this.columnColor(note.lane) : this.missColor()
      if (note.kind === 'hold' && (note.duration ?? 0) > 0.05) {
        const tailY = receptorY + direction * (((note.time + (note.duration ?? 0)) * 1000 - fx.frozenMs) / 1000) * pxPerSec + shift
        this.drawHoldBody(x, headY, tailY, noteH, missColor, 'dropping', 1, note.lane, 0.6 * fade)
      }
      ctx.save()
      ctx.globalAlpha = fade
      drawCentered(ctx, this.noteSprite('note', missColor, note.lane, noteH, hy), x, headY, size)
      ctx.restore()
      return true
    })

    session.forEachPending(untilMs, (note: ChartNote) => {
      const delta = note.time * 1000 - songTimeMs
      const hy = this.tileHyFor(note)
      const shift = this.tileShift(hy)
      const y = receptorY + direction * (delta / 1000) * pxPerSec + shift
      const x = laneX[note.lane] + laneW / 2
      const color = this.columnColor(note.lane)
      if (note.kind === 'hold' && note.duration && note.duration > 0.05) {
        const tailY = receptorY + direction * ((delta + note.duration * 1000) / 1000) * pxPerSec + shift
        this.drawHoldBody(x, y, tailY, noteH, color, 'waiting', 1, note.lane)
        this.drawHoldEnd(x, tailY, noteH, color, note.lane)
      }
      const margin = noteH * Math.max(1, hy)
      if (direction === 1 ? y > this.height + margin || y < -margin : y < -margin || y > this.height + margin) return
      const sprite = this.noteSprite('note', color, note.lane, noteH, hy)
      // Past its target and still not hit: it turns red right there, then fades out once missed.
      const late = Math.max(0, Math.min(1, (-delta - LATE_RED_FROM_MS) / LATE_RED_MS))
      if (late <= 0) {
        drawCentered(ctx, sprite, x, y, noteH)
        return
      }
      ctx.save()
      ctx.globalAlpha = 1 - late
      drawCentered(ctx, sprite, x, y, noteH)
      ctx.globalAlpha = late
      drawCentered(ctx, this.noteSprite('note', this.missColor(), note.lane, noteH, hy), x, y, noteH)
      ctx.restore()
    })
  }

  private missColor(): string {
    return this.settings.theme === 'mono' ? '#6a6a6a' : MISS_COLOR
  }

  /**
   * A piano tile's height, in the half-note units its shape uses. Every tile is the same long
   * block; one is only cut shorter when the next tile in its column would otherwise run into it.
   */
  private tileHyFor(note: ChartNote): number {
    if (this.settings.noteShape !== 'tile') return TILE_BASE_HY
    if (note.kind === 'hold') return TILE_HY
    const { noteH, pxPerSec } = this.layout()
    const room = ((this.laneGap.get(note.id) ?? Infinity) * pxPerSec - TILE_GAP_PX) / Math.max(1, noteH)
    return Math.max(TILE_MIN_HY, Math.floor(Math.min(TILE_HY, room) * 10) / 10)
  }

  /**
   * Piano tiles are timed by their leading edge: a tile is on time when its front edge lands on the
   * target bar, the way a player reads a tile. Every other style is timed by its centre.
   */
  private tileShift(hy: number): number {
    if (this.settings.noteShape !== 'tile') return 0
    const { noteH, direction } = this.layout()
    return (direction * hy * noteH) / 2
  }

  /**
   * A long arrow: the head arrow itself stretched toward its tail. The arrow is cut
   * across its middle and the half on the tail side slides down the hold, so its own sides become
   * the hold's edges instead of a separate bar.
   */
  private drawHoldBody(
    cx: number,
    headY: number,
    tailY: number,
    noteH: number,
    color: string,
    state: 'waiting' | 'active' | 'dropping',
    life: number,
    lane: Lane,
    alpha?: number,
  ): void {
    const length = Math.abs(tailY - headY)
    if (length < 1) return
    const towardTail = tailY >= headY ? 1 : -1
    const half = noteH / 2
    const turn = UNROTATED.has(this.settings.noteShape) ? 0 : LANE_ANGLE[lane]
    const cos = Math.cos(turn)
    const sin = Math.sin(turn)
    const shape = shapePoints(this.settings.noteShape, TILE_HY, this.tileHx).map(([px, py]) => [cx + (px * cos - py * sin) * half, headY + (px * sin + py * cos) * half])
    // Cut where the shape is widest, so an up or down arrow stretches its whole head instead of a
    // thin stem; sideways arrows and round shapes are widest through the middle and cut there.
    const cutY = headY + widestCut(shape, headY, half)
    const tailSide = (y: number): boolean => (y - cutY) * towardTail > 1e-6
    const shift = (x: number, y: number): [number, number] => [x, tailSide(y) ? y + towardTail * length : y]
    const path = new Path2D()
    const points: [number, number][] = []
    for (let k = 0; k < shape.length; k++) {
      const [x1, y1] = shape[k]
      const [x2, y2] = shape[(k + 1) % shape.length]
      points.push(shift(x1, y1))
      // A corner sitting exactly on the cut (a sideways arrow's tip) gets a second copy at the far
      // end, so its side runs straight down the hold instead of slanting.
      const onCut = (y: number): boolean => Math.abs(y - cutY) <= 1e-6
      if (onCut(y1) && tailSide(y2)) points.push([x1, cutY + towardTail * length])
      if (tailSide(y1) && onCut(y2)) points.push([x2, cutY + towardTail * length])
      // Where an edge crosses the cut, add both ends of the new straight side.
      if (tailSide(y1) !== tailSide(y2) && Math.abs(y2 - y1) > 1e-6) {
        const t = (cutY - y1) / (y2 - y1)
        if (t > 0 && t < 1) {
          const x = x1 + (x2 - x1) * t
          const near: [number, number] = [x, cutY]
          const far: [number, number] = [x, cutY + towardTail * length]
          if (tailSide(y1)) points.push(far, near)
          else points.push(near, far)
        }
      }
    }
    points.forEach(([x, y], index) => (index === 0 ? path.moveTo(x, y) : path.lineTo(x, y)))
    path.closePath()
    const ctx = this.ctx
    const fill = ctx.createLinearGradient(cx - half, 0, cx + half, 0)
    fill.addColorStop(0, shade(color, -0.25))
    fill.addColorStop(0.5, state === 'active' ? shade(color, 0.5) : shade(color, 0.2))
    fill.addColorStop(1, shade(color, -0.25))
    ctx.save()
    ctx.globalAlpha = alpha ?? (state === 'waiting' ? 0.9 : state === 'active' ? 1 : 0.35 + 0.5 * life)
    ctx.fillStyle = fill
    ctx.fill(path)
    ctx.lineJoin = 'round'
    ctx.lineWidth = Math.max(1.5, noteH * 0.035)
    ctx.strokeStyle = shade(color, 0.6)
    ctx.stroke(path)
    ctx.restore()
  }

  /** The release arrow at a hold's tail: let go when it reaches the target. */
  private drawHoldEnd(x: number, tailY: number, noteH: number, color: string, lane: Lane, alpha = 0.85): void {
    if (tailY < -noteH || tailY > this.height + noteH) return
    if (this.settings.holdEndArrow === false) return
    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = alpha
    drawCentered(ctx, this.noteSprite('note', color, lane, noteH), x, tailY, noteH * 0.82)
    ctx.restore()
  }

  /** The flickering glow on a receptor while its hold is down (StepMania's hold explosion). */
  private drawHoldGlow(x: number, y: number, noteH: number, color: string): void {
    const ctx = this.ctx
    const flicker = 0.22 + 0.12 * Math.abs(Math.sin(this.nowMs / 32))
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = flicker
    drawCentered(ctx, this.glowSprite(color, Math.round(noteH)), x, y, noteH * 1.5)
    ctx.restore()
    if (this.quality === 2 && Math.random() < 0.25) {
      this.particles.burst(x, y, color, { count: 1, strength: 0.7 })
    }
  }

  private drawExplosions(): void {
    const ctx = this.ctx
    const { laneX, laneW, receptorY, noteH } = this.layout()
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (let lane = 0; lane < 4; lane++) {
      const blast = this.explosion[lane]
      if (!blast) continue
      const age = this.nowMs - blast.at
      if (age > 400) {
        this.explosion[lane] = null
        continue
      }
      // Full brightness for 100 ms, then a decelerating fade (StepMania's tap explosion timing).
      const fade = age < 80 ? 1 : 1 - easeOut((age - 80) / 320)
      const grow = this.settings.reducedMotion ? 1 : 1 + 0.2 * easeOut(Math.min(1, age / 300))
      const x = laneX[lane] + laneW / 2
      ctx.globalAlpha = fade * 0.35
      drawCentered(ctx, this.glowSprite(blast.color, Math.round(noteH)), x, receptorY, noteH * 1.45 * grow)
    }
    ctx.restore()
  }

  /* ---------------------------------------------------------------- sprites */

  /** Cached arrow tile: 'note' is the coloured arrow, 'receptor' the grey target, 'flash' white. */
  private noteSprite(kind: 'note' | 'receptor' | 'flash', color: string, lane: Lane, size: number, hy?: number): HTMLCanvasElement {
    const shape = this.settings.noteShape
    const tileHy = shape === 'tile' ? hy ?? TILE_HY : TILE_BASE_HY
    const tileHx = shape === 'tile' ? this.tileHx : TILE_BASE_HX
    const key = `${kind}|${color}|${kind === 'flash' && shape === 'orb' ? 0 : lane}|${shape}|${Math.round(size)}|${tileHy}|${tileHx}`
    const cached = this.spriteCache.get(key)
    if (cached) return cached
    const scale = this.dpr
    // Room for the glow: a halo cut off by the sprite's edge shows as a hard straight line.
    const pad = Math.ceil(size * (0.6 + Math.max(tileHy - TILE_BASE_HY, tileHx - TILE_BASE_HX) / 2))
    const box = Math.ceil(size + pad * 2)
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(box * scale)
    canvas.height = Math.ceil(box * scale)
    const ctx = canvas.getContext('2d')!
    ctx.scale(scale, scale)
    const c = box / 2
    // Piano tiles are the same block in every column; everything else points its lane's way.
    const angle = UNROTATED.has(shape) ? 0 : LANE_ANGLE[lane]
    const path = tracePath(shape, size, angle, c, tileHy, tileHx)
    // Gradients span the shape's real height: a tall tile squeezed into a note-high gradient banded.
    const hh = shape === 'tile' ? (size * tileHy) / 2 : size / 2
    ctx.lineJoin = 'round'
    if (kind === 'note') {
      // Candy-gloss arrow: bright body, a hard white highlight on the top half, a light rim.
      const gradient = ctx.createLinearGradient(0, c - hh, 0, c + hh)
      gradient.addColorStop(0, shade(color, 0.7))
      gradient.addColorStop(0.3, shade(color, 0.15))
      gradient.addColorStop(0.75, color)
      gradient.addColorStop(1, shade(color, -0.25))
      ctx.fillStyle = gradient
      // A halo in the arrow's own colour so it reads as lit, not painted.
      ctx.save()
      ctx.shadowColor = color
      ctx.shadowBlur = size * 0.26 * scale
      ctx.fill(path)
      ctx.restore()
      ctx.save()
      ctx.clip(path)
      const gloss = ctx.createLinearGradient(0, c - hh, 0, c + hh * 0.04)
      gloss.addColorStop(0, 'rgba(255,255,255,0.85)')
      gloss.addColorStop(0.55, 'rgba(255,255,255,0.35)')
      gloss.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = gloss
      ctx.fillRect(0, 0, box, c + hh * 0.04)
      // A thin specular glint along the lower edge, like light bouncing off plastic.
      const glint = ctx.createLinearGradient(0, c + hh * 0.6, 0, c + hh)
      glint.addColorStop(0, 'rgba(255,255,255,0)')
      glint.addColorStop(1, 'rgba(255,255,255,0.35)')
      ctx.fillStyle = glint
      ctx.fillRect(0, c + hh * 0.6, box, hh * 0.4)
      ctx.restore()
      ctx.lineWidth = Math.max(1.5, size * 0.035)
      ctx.strokeStyle = shade(color, 0.6)
      ctx.stroke(path)
    } else if (kind === 'receptor') {
      ctx.fillStyle = 'rgba(14, 12, 30, 0.75)'
      ctx.fill(path)
      const rim = ctx.createLinearGradient(0, c - hh, 0, c + hh)
      rim.addColorStop(0, shade(color, 0.55))
      rim.addColorStop(1, shade(color, -0.2))
      ctx.lineWidth = Math.max(1.5, size * 0.05)
      ctx.strokeStyle = rim
      ctx.shadowColor = color
      ctx.shadowBlur = size * 0.2 * scale
      ctx.stroke(path)
      ctx.shadowBlur = 0
      ctx.stroke(path)
    } else {
      // The lit-up target: the column's colour, bright at the top, with a soft halo.
      ctx.shadowColor = color
      ctx.shadowBlur = size * 0.3 * scale
      const lit = ctx.createLinearGradient(0, c - hh, 0, c + hh)
      lit.addColorStop(0, shade(color, 0.75))
      lit.addColorStop(1, color)
      ctx.fillStyle = lit
      ctx.fill(path)
    }
    canvas.dataset.tile = String(size)
    canvas.dataset.box = String(box)
    this.spriteCache.set(key, canvas)
    return canvas
  }

  /** Cached soft radial glow in one colour. */
  private glowSprite(color: string, radius: number): HTMLCanvasElement {
    const r = Math.max(8, radius)
    const key = `glow|${color}|${r}`
    const cached = this.spriteCache.get(key)
    if (cached) return cached
    const canvas = document.createElement('canvas')
    canvas.width = r * 2
    canvas.height = r * 2
    const ctx = canvas.getContext('2d')!
    const gradient = ctx.createRadialGradient(r, r, 0, r, r, r)
    gradient.addColorStop(0, color)
    gradient.addColorStop(0.35, color)
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.globalAlpha = 0.9
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, r * 2, r * 2)
    this.spriteCache.set(key, canvas)
    return canvas
  }

  /* -------------------------------------------------------------------- hud */

  /** Judgment and combo sit together in the middle of the highway, clear of the receptors. */
  private judgmentY(): number {
    const { receptorY, direction } = this.layout()
    const travel = direction === 1 ? this.height - receptorY : receptorY
    return receptorY + direction * travel * 0.34
  }

  private drawJudgmentFlash(): void {
    const flash = this.flash
    if (!flash) return
    const { laneAreaX, laneAreaW } = this.layout()
    const age = flash.ageMs
    if (age > 750) return
    const ctx = this.ctx
    const x = laneAreaX + laneAreaW / 2
    const reduced = this.settings.reducedMotion
    // Punch in from 135%, hold, then fade while drifting a little.
    const zoom = reduced ? 1 : age < 80 ? 1.35 - 0.35 * (age / 80) : 1
    const alpha = age < 520 ? 1 : 1 - (age - 520) / 230
    const y = this.judgmentY() - (reduced ? 0 : Math.max(0, age - 520) * 0.04)
    const text = (flash.holdDrop ? 'LET GO' : JUDGMENT_LABEL[flash.judgment]).toUpperCase()
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(zoom, zoom)
    ctx.globalAlpha = Math.max(0, alpha)
    this.drawText(ctx, text, 0, 0, Math.min(30, laneAreaW / 10) * this.textScale(), this.judgeStyle(flash.judgment), this.quality > 0)
    ctx.restore()
  }

  private drawCombo(hud: HudState): void {
    if (hud.combo < 3) return
    const ctx = this.ctx
    const { laneAreaX, laneAreaW } = this.layout()
    const x = laneAreaX + laneAreaW / 2
    const y = this.judgmentY() + 42 * this.textScale()
    const reduced = this.settings.reducedMotion
    const sinceBump = this.nowMs - this.comboBumpAt
    const sinceMilestone = this.nowMs - this.comboMilestoneAt
    // Every hit gives a small pop; every 50 gives a bigger one and a ring.
    const bump = sinceBump < 120 ? 0.14 * (1 - sinceBump / 120) : 0
    const milestone = sinceMilestone < 260 ? 0.35 * (1 - sinceMilestone / 260) : 0
    const zoom = reduced ? 1 : 1 + Math.max(bump, milestone)
    const tier = comboTier(hud.combo)
    const style: JudgeStyle = this.settings.theme === 'mono' ? MONO_JUDGE : tier
    // The glow grows with the combo.
    const glow = 0.35 + Math.min(0.75, hud.combo / 400)
    if (!reduced && sinceMilestone < 500 && this.quality > 0) {
      const t = sinceMilestone / 500
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.strokeStyle = hexToRgba(style.burst, 0.6 * (1 - t))
      ctx.lineWidth = 4 * (1 - t) + 1
      ctx.beginPath()
      ctx.arc(x, y, 30 + t * 90, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(zoom, zoom)
    this.drawText(ctx, String(hud.combo), 0, 0, 38 * this.textScale(), style, this.quality > 0, Math.round(glow * 20) / 20)
    ctx.restore()
    this.drawText(ctx, 'COMBO', x, y + 28 * this.textScale(), 15, style, this.quality > 0, 0.6)
  }

  /**
   * Big arcade text through a cache: the chrome gradient and the glow (a canvas shadow blur, the
   * most expensive thing on screen) are painted once per text and size, then copied each frame.
   */
  private drawText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    size: number,
    style: JudgeStyle,
    glow: boolean,
    glowScale = 0.5,
  ): void {
    const px = Math.round(size)
    const key = `${text}|${px}|${style.fill}|${style.burst}|${glow ? glowScale : 'flat'}`
    let entry = this.textCache.get(key)
    if (!entry) {
      const measure = this.ctx
      measure.save()
      measure.font = `${px}px ${DISPLAY}`
      const textW = measure.measureText(text).width
      measure.restore()
      const pad = Math.ceil(px * (glow ? glowScale * 2 : 0.2)) + 6
      const w = Math.ceil(textW + pad * 2)
      const h = Math.ceil(px * 1.4 + pad * 2)
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(w * this.dpr)
      canvas.height = Math.ceil(h * this.dpr)
      const c = canvas.getContext('2d')!
      c.scale(this.dpr, this.dpr)
      paintStyledText(c, text, w / 2, h / 2, px, style, glow, glowScale)
      entry = { canvas, w, h }
      if (this.textCache.size > 160) this.textCache.delete(this.textCache.keys().next().value as string)
      this.textCache.set(key, entry)
    }
    ctx.drawImage(entry.canvas, x - entry.w / 2, y - entry.h / 2, entry.w, entry.h)
  }

  /** Cut text with an ellipsis so it fits `maxWidth` at the current font. Cached by input. */
  private fitTitle(text: string, maxWidth: number): string {
    const key = `${text}|${Math.round(maxWidth)}`
    if (this.titleCache.key === key) return this.titleCache.text
    let fitted = text
    if (this.ctx.measureText(fitted).width > maxWidth) {
      while (fitted.length > 1 && this.ctx.measureText(`${fitted}…`).width > maxWidth) fitted = fitted.slice(0, -1)
      fitted = `${fitted.trimEnd()}…`
    }
    this.titleCache = { key, text: fitted }
    return fitted
  }

  private drawHud(hud: HudState): void {
    const ctx = this.ctx
    const palette = PALETTES[this.settings.theme]
    const { laneAreaX, laneAreaW } = this.layout()
    // Locale formatting and fixed-decimal strings are cached by value: they only change when the
    // score does, not every frame.
    if (this.scoreTextCache.value !== hud.score) {
      this.scoreTextCache = { value: hud.score, text: hud.score.toLocaleString('en-US') }
    }
    const accuracy = Math.round(hud.accuracy * 10000) / 10000
    if (this.accuracyTextCache.value !== accuracy) {
      this.accuracyTextCache = { value: accuracy, text: `${(accuracy * 100).toFixed(2)}%` }
    }
    const progress = Math.max(0, Math.min(1, hud.progress))
    const progressStyle = this.settings.progressStyle ?? 'top'
    ctx.save()
    ctx.textBaseline = 'top'

    const progressBar = (x: number, y: number, w: number, h: number): void => {
      ctx.fillStyle = 'rgba(255,255,255,0.12)'
      ctx.fillRect(x, y, w, h)
      const fill = ctx.createLinearGradient(x, 0, x + w, 0)
      const mono = this.settings.theme === 'mono'
      fill.addColorStop(0, mono ? palette.accent : this.railColors[0])
      fill.addColorStop(1, mono ? palette.accent2 : this.railColors[1])
      ctx.fillStyle = fill
      ctx.fillRect(x, y, w * progress, h)
      if (progress > 0 && progress < 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)'
        ctx.fillRect(x + w * progress - 2, y - 1, 3, h + 2)
      }
    }

    if (laneAreaX >= 180) {
      // Wide screens: two columns hugging the highway, score on the left, the song on the right.
      const leftX = laneAreaX - 30
      const rightX = laneAreaX + laneAreaW + 30
      const top = 76
      ctx.textAlign = 'right'
      ctx.font = `600 15px ${FONT}`
      ctx.fillStyle = palette.hudMuted
      ctx.fillText('Score', leftX, top)
      ctx.font = `22px ${DISPLAY}`
      ctx.fillStyle = palette.hudText
      ctx.fillText(this.scoreTextCache.text, leftX, top + 20)
      ctx.font = `600 15px ${FONT}`
      ctx.fillStyle = palette.hudMuted
      ctx.fillText('Accuracy', leftX, top + 58)
      ctx.font = `22px ${DISPLAY}`
      ctx.fillStyle = palette.hudText
      ctx.fillText(this.accuracyTextCache.text, leftX, top + 78)
      if (progressStyle === 'text') {
        ctx.font = `600 15px ${FONT}`
        ctx.fillStyle = palette.hudMuted
        ctx.fillText('Progress', leftX, top + 116)
        ctx.font = `22px ${DISPLAY}`
        ctx.fillStyle = palette.hudText
        ctx.fillText(`${Math.round(progress * 100)}%`, leftX, top + 136)
      }

      ctx.textAlign = 'left'
      // The title may use the whole column out to the screen edge; only the bar keeps a set width.
      const titleW = this.width - rightX - 24
      if (hud.title) {
        ctx.font = `700 19px ${FONT}`
        ctx.fillStyle = palette.hudText
        ctx.fillText(this.fitTitle(hud.title, titleW), rightX, top)
      }
      if (hud.subtitle) {
        ctx.font = `18px ${DISPLAY}`
        ctx.fillStyle = this.settings.theme === 'mono' ? palette.hudText : hud.subtitleColor ?? palette.accent2
        ctx.fillText(hud.subtitle, rightX, top + 28)
      }
      if (progressStyle === 'column') progressBar(rightX, top + 58, Math.min(220, titleW), 5)
    } else {
      // Narrow screens: one compact row above the receptors, below the pause/fullscreen buttons.
      const y = 50
      ctx.font = `19px ${DISPLAY}`
      ctx.fillStyle = palette.hudText
      ctx.textAlign = 'left'
      ctx.fillText(this.scoreTextCache.text, 16, y)
      ctx.textAlign = 'right'
      ctx.fillText(this.accuracyTextCache.text, this.width - 16, y)
    }
    // Song progress runs along the very top of the window on every screen size.
    // On narrow screens there is no column, so every style falls back to the line along the top.
    if (progressStyle === 'top' || laneAreaX < 180) progressBar(0, 0, this.width, 5)

    // Frame rate / quality readout (Settings → Show statistics). Shows the adaptive level so a
    // performance drop is visible instead of felt.
    if (hud.showStats) {
      const fps = this.frameEma > 0 ? Math.min(999, Math.round(1000 / this.frameEma)) : 0
      ctx.textAlign = 'right'
      ctx.font = `600 11px ${FONT}`
      ctx.fillStyle = palette.hudMuted
      ctx.fillText(`${fps} FPS - Q${this.quality + 1}`, this.width - 22, this.height - 30)
    }
    ctx.restore()
  }

  /** Judgment and combo shrink with a short preview canvas. */
  private textScale(): number {
    return this.preview ? Math.max(0.55, Math.min(1, this.height / 480)) : 1
  }

  /** How long an arrow takes to travel up to its target: the run-up after the countdown. */
  leadInMs(): number {
    return this.layout().travelSeconds * 1000
  }

  private drawCountdown(hud: HudState): void {
    if (hud.countdownMs === null) return
    // Positive: the 3-2-1 numbers. Zero and below: GO! during the run-up, fading out.
    const remaining = hud.countdownMs
    const number = remaining > 0 ? Math.ceil(remaining / 1000) : 0
    const goAge = Math.max(0, -remaining)
    if (number === 0 && goAge > 700) return
    const ctx = this.ctx
    const phase = number > 0 ? 1 - (remaining % 1000) / 1000 : Math.min(1, goAge / 350)
    const reduced = this.settings.reducedMotion
    const scale = reduced ? 1 : 1 + (1 - Math.min(1, phase * 3)) * 0.45
    const x = this.width / 2
    const y = this.height * 0.42
    ctx.save()
    if (number === 0) ctx.globalAlpha = Math.max(0, 1 - goAge / 700)
    if (!reduced) {
      ctx.globalCompositeOperation = 'lighter'
      ctx.strokeStyle = this.settings.theme === 'mono' ? `rgba(255, 255, 255, ${0.35 * (1 - phase)})` : hexToRgba(this.columnColors[(3 - number + 4) % 4], 0.5 * (1 - phase))
      ctx.lineWidth = 6
      ctx.beginPath()
      ctx.arc(x, y, 60 + phase * 140, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalCompositeOperation = 'source-over'
    }
    ctx.translate(x, y)
    ctx.scale(scale, scale)
    // Each of 3, 2, 1 and GO takes one of the four column colours.
    const countColor = this.columnColors[(3 - number + 4) % 4]
    const countStyle: JudgeStyle =
      this.settings.theme === 'mono' ? MONO_JUDGE : { fill: countColor, shadow: shade(countColor, -0.5), burst: countColor }
    this.drawText(ctx, number > 0 ? String(number) : 'GO!', 0, 0, 96, countStyle, this.quality > 0)
    ctx.restore()
  }
}

/* -------------------------------------------------------------------- helpers */

function validColors(colors: string[] | undefined): string[] {
  const ok = Array.isArray(colors) && colors.length === 4 && colors.every((c) => /^#[0-9a-f]{6}$/i.test(c))
  return ok ? [...colors] : [...COLUMN_COLORS]
}

/** Combo colour climbs with the combo: white, then yellow, orange, pink, purple and cyan. */
function comboTier(combo: number): JudgeStyle {
  const tiers: [number, string, string][] = [
    [500, '#3de9ff', '#13708a'],
    [300, '#b35cff', '#55208a'],
    [200, '#ff4f9a', '#8a1648'],
    [100, '#ff7a3d', '#8a3a10'],
    [50, '#ffc93d', '#8a5a06'],
  ]
  for (const [min, fill, shadow] of tiers) if (combo >= min) return { fill, shadow, burst: fill }
  return { fill: '#ffffff', shadow: '#4a4a66', burst: '#ffffff' }
}

function shuffledColors(): string[] {
  const pool = [...SHUFFLE_COLORS]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, 4)
}

const TILE_BASE_HY = 0.95
const TILE_BASE_HX = 0.92
/** Every piano tile's height (1.8 notes tall), unless the next tile in its column is too close. */
const TILE_HY = 1.8
const TILE_MIN_HY = 0.5
/** The flat bar a tile lands on. */
const TILE_BAR_HY = 0.4
/** Space kept between two tiles in one column. */
const TILE_GAP_PX = 6
/** Shapes drawn the same way up in every column. */
const UNROTATED = new Set<NoteShape>(['tile', 'square'])

/** Offset from the centre, within half a note, of the shape's widest horizontal cross-section. */
function widestCut(shape: number[][], centerY: number, half: number): number {
  let best = 0
  let bestWidth = -1
  for (let step = 0; step <= 40; step++) {
    const d = ((step - 20) / 20) * half * 0.9
    const y = centerY + d
    let min = Infinity
    let max = -Infinity
    for (let k = 0; k < shape.length; k++) {
      const [x1, y1] = shape[k]
      const [x2, y2] = shape[(k + 1) % shape.length]
      if ((y1 - y) * (y2 - y) > 0 || Math.abs(y2 - y1) < 1e-9) continue
      const x = x1 + ((x2 - x1) * (y - y1)) / (y2 - y1)
      min = Math.min(min, x)
      max = Math.max(max, x)
    }
    const width = max - min
    // A clearly wider slice wins; near-equal ones go to the one closest to the middle.
    if (width > bestWidth * 1.02 || (width >= bestWidth * 0.98 && Math.abs(d) < Math.abs(best))) {
      if (width > bestWidth) bestWidth = width
      best = d
    }
  }
  return best
}

function laneGaps(notes: readonly ChartNote[]): Map<string, number> {
  const gaps = new Map<string, number>()
  const previous: (ChartNote | null)[] = [null, null, null, null]
  for (const note of [...notes].sort((a, b) => a.time - b.time)) {
    const before = previous[note.lane]
    if (before) gaps.set(before.id, note.time - before.time)
    previous[note.lane] = note
  }
  return gaps
}

/** The arcade arrow pointing right, in a unit box centred on 0 (shared by sprites and stretched holds). */
const ARROW_POINTS: [number, number][] = [[-0.94, -0.3], [0.02, -0.3], [0.02, -0.9], [0.96, 0], [0.02, 0.9], [0.02, 0.3], [-0.94, 0.3]]

/** The arrow (or skin shape) traced around a centre point, rotated for its lane. */
/** A skin's outline as unit points around 0, pointing right (the orb as a 24-sided circle). */
function shapePoints(shape: NoteShape, tileHy = TILE_BASE_HY, tileHx = TILE_BASE_HX): [number, number][] {
  const points: [number, number][] = []
  if (shape === 'arrow' || shape === 'bar') {
    // A chunky arcade arrow pointing right, filling the square tile.
    points.push(...ARROW_POINTS)
  } else if (shape === 'square') {
    points.push([-0.88, -0.88], [0.88, -0.88], [0.88, 0.88], [-0.88, 0.88])
  } else if (shape === 'tile') {
    // A piano tile: a block nearly as wide as its column (glow included), as tall as the chart allows.
    points.push([-tileHx, -tileHy], [tileHx, -tileHy], [tileHx, tileHy], [-tileHx, tileHy])
  } else if (shape === 'chevron') {
    points.push([-0.85, -0.92], [0.95, 0], [-0.85, 0.92], [-0.3, 0])
  } else if (shape === 'diamond') {
    points.push([-0.95, 0], [0, -0.95], [0.95, 0], [0, 0.95])
  } else if (shape === 'star') {
    for (let i = 0; i < 10; i++) {
      const radius = i % 2 === 0 ? 0.96 : 0.44
      const a = -Math.PI / 2 + (i * Math.PI) / 5
      points.push([Math.cos(a) * radius, Math.sin(a) * radius])
    }
  } else if (shape === 'hex') {
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3
      points.push([Math.cos(a) * 0.94, Math.sin(a) * 0.94])
    }
  } else {
    for (let i = 0; i < 24; i++) {
      const a = (i * Math.PI) / 12
      points.push([Math.cos(a) * 0.9, Math.sin(a) * 0.9])
    }
  }
  return points
}

function tracePath(shape: NoteShape, size: number, angle: number, center: number, tileHy = TILE_BASE_HY, tileHx = TILE_BASE_HX): Path2D {
  const points = shapePoints(shape, tileHy, tileHx)
  const s = size / 2
  const path = new Path2D()
  if (shape === 'orb') {
    path.arc(center, center, s * 0.9, 0, Math.PI * 2)
    return path
  }
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  points.forEach(([px, py], index) => {
    const x = center + (px * cos - py * sin) * s
    const y = center + (px * sin + py * cos) * s
    if (index === 0) path.moveTo(x, y)
    else path.lineTo(x, y)
  })
  path.closePath()
  return path
}

function drawCentered(ctx: CanvasRenderingContext2D, sprite: HTMLCanvasElement, x: number, y: number, size: number): void {
  // Arrow sprites carry padding around their tile, recorded on the canvas; glows have none.
  const tile = Number(sprite.dataset.tile ?? 0)
  const w = tile > 0 ? (Number(sprite.dataset.box) * size) / tile : size
  ctx.drawImage(sprite, x - w / 2, y - w / 2, w, w)
}

/** Big arcade text: chrome lettering with a glow in its own colour. */
function paintStyledText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  style: JudgeStyle,
  glow = false,
  glowScale = 0.5,
): void {
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${Math.round(size)}px ${DISPLAY}`
  // With a glow the letters need no drop; without one (slow machines) a hard drop keeps depth.
  if (!glow) {
    ctx.fillStyle = style.shadow
    ctx.fillText(text, x, y + Math.max(2, Math.round(size * 0.09)))
  }
  // Chrome lettering: a near-white top half that breaks sharply into the colour at the middle.
  const top = y - size * 0.45
  const shine = ctx.createLinearGradient(0, top, 0, y + size * 0.45)
  shine.addColorStop(0, '#ffffff')
  shine.addColorStop(0.42, shade(style.fill, 0.55))
  shine.addColorStop(0.5, style.fill)
  shine.addColorStop(1, shade(style.fill, -0.18))
  ctx.fillStyle = shine
  if (glow) {
    ctx.shadowColor = style.burst
    ctx.shadowBlur = size * glowScale
  }
  ctx.fillText(text, x, y)
  ctx.restore()
}

function easeOut(t: number): number {
  const clamped = Math.max(0, Math.min(1, t))
  return 1 - (1 - clamped) * (1 - clamped)
}

/** Lighten (amount > 0) or darken (amount < 0) a #rrggbb colour. */
function shade(hex: string, amount: number): string {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
  const mixed = channels.map((c) =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)),
  )
  return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`
}

/** #rrggbb → rgba(...) with the given alpha. */
export function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const r = parseInt(full.slice(0, 2), 16)
  const g = parseInt(full.slice(2, 4), 16)
  const b = parseInt(full.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}
