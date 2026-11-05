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
export type NoteShape = 'arrow' | 'chevron' | 'diamond' | 'orb' | 'star' | 'hex' | 'bar'
/** 'up' = arcade layout (targets at the top, arrows rise); 'down' = classic falling arrows. */
export type ScrollDirection = 'up' | 'down'
/** Whole-app skin: the colour arcade, or a pitch-black room lit only in white. */
export type ThemeName = 'neon' | 'disco' | 'mono'
/** Arrow colours: one fixed colour per column, or a fresh random set every song. */
export type ArrowColors = 'column' | 'random'

export interface RenderSettings {
  /** 1 (slow) … 10 (fast). Converted to pixels per second using the travel distance. */
  scrollSpeed: number
  /** One multiplier for tap notes, hold notes and receptors, 0.8…1.7. */
  noteScale: number
  /** How much the background moves: full show, calmer, or a still backdrop. */
  laneStyle: LaneStyle
  noteShape: NoteShape
  scrollDirection: ScrollDirection
  theme: ThemeName
  arrowColors: ArrowColors
  /** The four column colours the player picked (used when arrow colours are per column). */
  columnColors: string[]
  reducedMotion: boolean
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  scrollSpeed: 5,
  noteScale: 1.3,
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
    accent: '#ff3d7f',
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
  private lastCombo = 0
  private comboBumpAt = -1e9

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
    this.columnColors =
      this.settings.arrowColors === 'random' ? shuffledColors() : validColors(this.settings.columnColors)
    const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5)
    this.railColors = [this.columnColors[order[0]], this.columnColors[order[1]]]
    if (!chart) return
    this.timing = new TimingMap(chart.timing)
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
    if (judgment === 'miss') return
    const color = this.columnColor(lane)
    this.explosion[lane] = { color, at: performance.now() }
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
    this.skyCache = null
    this.vignetteCache = null
  }

  private layout(): PlayfieldLayout {
    // Leave room for touch thumbs and for wide monitors: the playfield is a centred column.
    const key = `${this.width}x${this.height}:${this.dpr}:${this.settings.scrollSpeed}:${this.settings.noteScale}:${this.settings.scrollDirection}`
    const cached = this.layoutCache
    if (cached && this.layoutKey === key) return cached
    // StepMania sizes the playfield from the screen height, so a big monitor gets bigger arrows
    // instead of the same small column in a sea of empty space.
    const laneAreaW = this.preview ? this.width * 0.84 : Math.max(180, Math.min(this.width * 0.72, this.height * 0.62))
    const laneW = laneAreaW / 4
    const laneAreaX = (this.width - laneAreaW) / 2
    const direction: 1 | -1 = this.settings.scrollDirection === 'down' ? -1 : 1
    const fullNote = Math.min(laneW * 0.96, laneW * 0.66 * this.settings.noteScale)
    // A short preview canvas keeps the arrows in proportion to its height.
    const noteH = this.preview ? Math.min(fullNote, this.height * 0.2) : fullNote
    // The receptor inset mirrors between layouts: at the top for rising arrows, at the bottom
    // for falling ones, so touch-thumb room and HUD clearance are the same either way.
    const inset = this.preview ? noteH * 0.8 : Math.max(96, Math.min(this.height * 0.16, 150), 64 + noteH / 2)
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
      this.lastCombo = hud.combo
    }
    if (!reduced && this.quality > 0) this.particles.update(dtMs)

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
    const { laneX, laneW, laneAreaX, laneAreaW, receptorY, direction, noteH } = this.layout()
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

    // A beam shoots up the lane from a pressed receptor and fades after release.
    if (this.settings.reducedMotion) return
    for (let lane = 0; lane < 4; lane++) {
      const held = this.laneHeld[lane]
      const fade = held ? 1 : Math.max(0, 1 - (this.nowMs - this.releaseAt[lane]) / 180)
      if (fade <= 0) continue
      const length = (direction === 1 ? this.height - receptorY : receptorY) * 0.42
      // The beam fades in from behind the target as well as out along the lane, so it never
      // starts on a hard horizontal edge.
      const start = receptorY - direction * noteH * 0.6
      const end = receptorY + direction * length
      const beam = ctx.createLinearGradient(0, start, 0, end)
      const peak = (noteH * 0.6) / Math.max(1, Math.abs(end - start))
      beam.addColorStop(0, hexToRgba(this.columnColor(lane), 0))
      beam.addColorStop(peak, hexToRgba(this.columnColor(lane), 0.14 * fade))
      beam.addColorStop(1, hexToRgba(this.columnColor(lane), 0))
      ctx.fillStyle = beam
      ctx.fillRect(laneX[lane] + 2, Math.min(start, end), laneW - 4, Math.abs(end - start))
    }
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
      const sprite = this.noteSprite('receptor', this.columnColor(lane), lane as Lane, noteH)
      ctx.globalAlpha = 0.9
      drawCentered(ctx, sprite, x, receptorY, size)
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
        const flash = this.noteSprite('flash', this.columnColor(lane), lane as Lane, noteH)
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = overlay
        drawCentered(ctx, flash, x, receptorY, size * zoom)
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
      const tailY = receptorY + direction * (tailDeltaMs / 1000) * pxPerSec
      const color = this.columnColor(note.lane)
      const held = life >= 1
      this.drawHoldBody(x, receptorY, tailY, noteH, color, held ? 'active' : 'dropping', life)
      this.drawHoldEnd(x, tailY, noteH, color, note.lane)
      const sprite = this.noteSprite('note', color, note.lane, noteH)
      ctx.globalAlpha = held ? 1 : 0.45 + 0.55 * life
      drawCentered(ctx, sprite, x, receptorY, noteH)
      ctx.globalAlpha = 1
      if (held && !reduced && this.quality > 0) this.drawHoldGlow(x, receptorY, noteH, color)
    })

    session.forEachPending(untilMs, (note: ChartNote) => {
      const delta = note.time * 1000 - songTimeMs
      const y = receptorY + direction * (delta / 1000) * pxPerSec
      const x = laneX[note.lane] + laneW / 2
      const color = this.columnColor(note.lane)
      if (note.kind === 'hold' && note.duration && note.duration > 0.05) {
        const tailY = receptorY + direction * ((delta + note.duration * 1000) / 1000) * pxPerSec
        this.drawHoldBody(x, y, tailY, noteH, color, 'waiting', 1)
        this.drawHoldEnd(x, tailY, noteH, color, note.lane)
      }
      if (direction === 1 ? y > this.height + noteH || y < -noteH : y < -noteH || y > this.height + noteH) return
      const sprite = this.noteSprite('note', color, note.lane, noteH)
      drawCentered(ctx, sprite, x, y, noteH)
    })
  }

  /**
   * A hold's body: a glowing ribbon from the head to a rounded tail cap. While the key is down it
   * lights up and light bands race into the receptor; once released it greys out as it drains.
   */
  private drawHoldBody(
    cx: number,
    headY: number,
    tailY: number,
    noteH: number,
    color: string,
    state: 'waiting' | 'active' | 'dropping',
    life: number,
  ): void {
    const ctx = this.ctx
    const bodyW = noteH * 0.56
    const top = Math.min(headY, tailY)
    const bottom = Math.max(headY, tailY)
    const length = bottom - top
    if (length < 1) return
    const base = color
    const left = cx - bodyW / 2
    const gradient = ctx.createLinearGradient(left, 0, left + bodyW, 0)
    gradient.addColorStop(0, shade(base, -0.45))
    gradient.addColorStop(0.5, state === 'active' ? shade(base, 0.45) : shade(base, 0.1))
    gradient.addColorStop(1, shade(base, -0.45))
    ctx.save()
    ctx.globalAlpha = state === 'waiting' ? 0.78 : state === 'active' ? 1 : 0.35 + 0.5 * life
    ctx.fillStyle = gradient
    ctx.beginPath()
    roundedBar(ctx, left, top, bodyW, length, bodyW / 2, tailY > headY ? 'bottom' : 'top')
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(8, 6, 20, 0.85)'
    ctx.stroke()
    if (state === 'active' && !this.settings.reducedMotion) {
      // Light bands racing toward the receptor sell "you are holding this".
      ctx.clip()
      ctx.globalCompositeOperation = 'lighter'
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      const spacing = 26
      const direction = tailY > headY ? 1 : -1
      const offset = ((this.nowMs / 1000) * 260) % spacing
      for (let d = -spacing; d < length + spacing; d += spacing) {
        const along = direction === 1 ? d - offset : length - d + offset
        ctx.fillRect(left, top + along, bodyW, 7)
      }
    }
    ctx.restore()
  }

  /** The release arrow at a hold's tail: let go when it reaches the target. */
  private drawHoldEnd(x: number, tailY: number, noteH: number, color: string, lane: Lane): void {
    if (tailY < -noteH || tailY > this.height + noteH) return
    const ctx = this.ctx
    ctx.save()
    ctx.globalAlpha = 0.85
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
  private noteSprite(kind: 'note' | 'receptor' | 'flash', color: string, lane: Lane, size: number): HTMLCanvasElement {
    const shape = this.settings.noteShape
    const key = `${kind}|${color}|${kind === 'flash' && shape === 'orb' ? 0 : lane}|${shape}|${Math.round(size)}`
    const cached = this.spriteCache.get(key)
    if (cached) return cached
    const scale = this.dpr
    // Room for the glow: a halo cut off by the sprite's edge shows as a hard straight line.
    const pad = Math.ceil(size * 0.6)
    const box = Math.ceil(size + pad * 2)
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(box * scale)
    canvas.height = Math.ceil(box * scale)
    const ctx = canvas.getContext('2d')!
    ctx.scale(scale, scale)
    const c = box / 2
    const angle = LANE_ANGLE[lane]
    const path = tracePath(shape, size, angle, c)
    ctx.lineJoin = 'round'
    if (kind === 'note') {
      // Candy-gloss arrow: bright body, a hard white highlight on the top half, a light rim.
      const gradient = ctx.createLinearGradient(0, c - size / 2, 0, c + size / 2)
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
      const gloss = ctx.createLinearGradient(0, c - size / 2, 0, c + size * 0.02)
      gloss.addColorStop(0, 'rgba(255,255,255,0.85)')
      gloss.addColorStop(0.55, 'rgba(255,255,255,0.35)')
      gloss.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = gloss
      ctx.fillRect(0, 0, box, c + size * 0.02)
      // A thin specular glint along the lower edge, like light bouncing off plastic.
      const glint = ctx.createLinearGradient(0, c + size * 0.3, 0, c + size / 2)
      glint.addColorStop(0, 'rgba(255,255,255,0)')
      glint.addColorStop(1, 'rgba(255,255,255,0.35)')
      ctx.fillStyle = glint
      ctx.fillRect(0, c + size * 0.3, box, size * 0.2)
      ctx.restore()
      ctx.lineWidth = Math.max(1.5, size * 0.035)
      ctx.strokeStyle = shade(color, 0.6)
      ctx.stroke(path)
    } else if (kind === 'receptor') {
      ctx.fillStyle = 'rgba(14, 12, 30, 0.75)'
      ctx.fill(path)
      const rim = ctx.createLinearGradient(0, c - size / 2, 0, c + size / 2)
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
      const lit = ctx.createLinearGradient(0, c - size / 2, 0, c + size / 2)
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
    drawStyledText(ctx, text, 0, 0, Math.min(30, laneAreaW / 10) * this.textScale(), this.judgeStyle(flash.judgment), this.quality > 0)
    ctx.restore()
  }

  private drawCombo(hud: HudState): void {
    if (hud.combo < 3) return
    const ctx = this.ctx
    const { laneAreaX, laneAreaW } = this.layout()
    const x = laneAreaX + laneAreaW / 2
    const y = this.judgmentY() + 42 * this.textScale()
    const sinceBump = this.nowMs - this.comboBumpAt
    const zoom = this.settings.reducedMotion ? 1 : sinceBump < 120 ? 1.14 - 0.14 * (sinceBump / 120) : 1
    const hot = hud.combo >= 100
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(zoom, zoom)
    const comboStyle: JudgeStyle =
      this.settings.theme === 'mono'
        ? MONO_JUDGE
        : hot
          ? { fill: '#ff7a3d', shadow: '#8a3a10', burst: '#ff7a3d' }
          : { fill: '#3d9bff', shadow: '#163e80', burst: '#3d9bff' }
    drawStyledText(ctx, String(hud.combo), 0, 0, 38 * this.textScale(), comboStyle, this.quality > 0)
    ctx.restore()
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `700 14px ${FONT}`
    ctx.fillStyle = '#ffffff'
    if (this.quality > 0) {
      ctx.shadowColor = comboStyle.burst
      ctx.shadowBlur = 10
    }
    ctx.fillText('COMBO', x, y + 28 * this.textScale())
    ctx.restore()
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
    ctx.save()
    ctx.textBaseline = 'top'

    const progressBar = (x: number, y: number, w: number, h: number): void => {
      ctx.fillStyle = 'rgba(255,255,255,0.12)'
      ctx.fillRect(x, y, w, h)
      const fill = ctx.createLinearGradient(x, 0, x + w, 0)
      fill.addColorStop(0, palette.accent)
      fill.addColorStop(1, palette.accent2)
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
      ctx.font = `30px ${DISPLAY}`
      ctx.fillStyle = this.settings.theme === 'mono' ? '#4a4a4a' : palette.accent
      ctx.fillText(this.scoreTextCache.text, leftX + 2, top + 21)
      ctx.fillStyle = palette.hudText
      ctx.fillText(this.scoreTextCache.text, leftX, top + 18)
      ctx.font = `600 15px ${FONT}`
      ctx.fillStyle = palette.hudMuted
      ctx.fillText('Accuracy', leftX, top + 68)
      ctx.font = `22px ${DISPLAY}`
      ctx.fillStyle = palette.hudText
      ctx.fillText(this.accuracyTextCache.text, leftX, top + 88)

      ctx.textAlign = 'left'
      const columnW = Math.min(220, this.width - rightX - 24)
      if (hud.title) {
        ctx.font = `700 19px ${FONT}`
        ctx.fillStyle = palette.hudText
        ctx.fillText(this.fitTitle(hud.title, columnW), rightX, top)
      }
      if (hud.subtitle) {
        ctx.font = `13px ${DISPLAY}`
        ctx.fillStyle = palette.accent2
        ctx.fillText(hud.subtitle, rightX, top + 28)
      }
      progressBar(rightX, top + 52, columnW, 5)
    } else {
      // Narrow screens: one compact row above the receptors, below the pause/fullscreen buttons.
      const y = 50
      ctx.font = `19px ${DISPLAY}`
      ctx.fillStyle = palette.hudText
      ctx.textAlign = 'left'
      ctx.fillText(this.scoreTextCache.text, 16, y)
      ctx.textAlign = 'right'
      ctx.fillText(this.accuracyTextCache.text, this.width - 16, y)
      progressBar(0, 0, this.width, 4)
    }

    // Frame rate / quality readout (Settings → Show statistics). Shows the adaptive level so a
    // performance drop is visible instead of felt.
    if (hud.showStats) {
      const fps = this.frameEma > 0 ? Math.min(999, Math.round(1000 / this.frameEma)) : 0
      ctx.textAlign = 'right'
      ctx.font = `600 11px ${FONT}`
      ctx.fillStyle = palette.hudMuted
      ctx.fillText(`${fps} FPS · Q${this.quality + 1}`, this.width - 22, this.height - 30)
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
      ctx.strokeStyle = this.settings.theme === 'mono' ? `rgba(255, 255, 255, ${0.35 * (1 - phase)})` : `rgba(255, 210, 61, ${0.5 * (1 - phase)})`
      ctx.lineWidth = 6
      ctx.beginPath()
      ctx.arc(x, y, 60 + phase * 140, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalCompositeOperation = 'source-over'
    }
    ctx.translate(x, y)
    ctx.scale(scale, scale)
    const countStyle: JudgeStyle = this.settings.theme === 'mono' ? MONO_JUDGE : { fill: '#ff4f9a', shadow: '#8a1648', burst: '#ff4f9a' }
    drawStyledText(ctx, number > 0 ? String(number) : 'GO!', 0, 0, 96, countStyle, this.quality > 0)
    ctx.restore()
  }
}

/* -------------------------------------------------------------------- helpers */

function validColors(colors: string[] | undefined): string[] {
  const ok = Array.isArray(colors) && colors.length === 4 && colors.every((c) => /^#[0-9a-f]{6}$/i.test(c))
  return ok ? [...colors] : [...COLUMN_COLORS]
}

function shuffledColors(): string[] {
  const pool = [...SHUFFLE_COLORS]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, 4)
}

/** The arrow (or skin shape) traced around a centre point, rotated for its lane. */
function tracePath(shape: NoteShape, size: number, angle: number, center: number): Path2D {
  const points: [number, number][] = []
  const s = size / 2
  if (shape === 'arrow' || shape === 'bar') {
    // A chunky arcade arrow pointing right, filling the square tile.
    points.push([-0.94, -0.3], [0.02, -0.3], [0.02, -0.9], [0.96, 0], [0.02, 0.9], [0.02, 0.3], [-0.94, 0.3])
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
  }
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
function drawStyledText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  style: JudgeStyle,
  glow = false,
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
    ctx.shadowBlur = size * 0.5
  }
  ctx.fillText(text, x, y)
  ctx.restore()
}

/** A bar with one rounded end (the hold's tail cap). */
function roundedBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  roundEnd: 'top' | 'bottom',
): void {
  const radius = Math.min(r, h / 2, w / 2)
  if (roundEnd === 'bottom') {
    ctx.moveTo(x, y)
    ctx.lineTo(x + w, y)
    ctx.lineTo(x + w, y + h - radius)
    ctx.arc(x + w / 2, y + h - radius, w / 2, 0, Math.PI)
    ctx.lineTo(x, y)
  } else {
    ctx.moveTo(x, y + h)
    ctx.lineTo(x, y + radius)
    ctx.arc(x + w / 2, y + radius, w / 2, Math.PI, 0)
    ctx.lineTo(x + w, y + h)
    ctx.lineTo(x, y + h)
  }
  ctx.closePath()
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
