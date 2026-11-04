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
/** Whole-app skin. */
export type ThemeName = 'neon' | 'disco'

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
  reducedMotion: boolean
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  scrollSpeed: 5,
  noteScale: 1.3,
  laneStyle: 'neon',
  noteShape: 'arrow',
  scrollDirection: 'up',
  theme: 'disco',
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
    skyTop: '#1d0b45',
    skyBottom: '#05030f',
    lanePanel: 'rgba(6, 3, 18, 0.6)',
    hudText: '#ffffff',
    hudMuted: '#c3b8f0',
    accent: '#ff4fd8',
    accent2: '#3be8ff',
  },
}

/**
 * Arrow colour by rhythm, the StepMania convention: quarter notes red, eighths blue, twelfths
 * purple, sixteenths yellow, and so on. Reading the colour tells the player the subdivision.
 */
const QUANT_COLORS: readonly [number, string][] = [
  [1, '#ff3d5a'],
  [2, '#3d8bff'],
  [3, '#b35cff'],
  [4, '#ffd23d'],
  [6, '#ff6bd6'],
  [8, '#ff9a3d'],
  [12, '#3de9ff'],
  [16, '#45ff8f'],
]
const OFF_GRID_COLOR = '#a7b0c4'

interface JudgeStyle {
  top: string
  bottom: string
  glow: string
}

const JUDGE_STYLE: Record<Judgment, JudgeStyle> = {
  marvelous: { top: '#ffffff', bottom: '#7fe9ff', glow: '#3fd8ff' },
  perfect: { top: '#fff4a8', bottom: '#ffb300', glow: '#ffb300' },
  great: { top: '#d4ffb8', bottom: '#33d65a', glow: '#33d65a' },
  good: { top: '#c4e0ff', bottom: '#3d86ff', glow: '#3d86ff' },
  miss: { top: '#ffc0c0', bottom: '#ff3030', glow: '#ff2020' },
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

const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif'

/** Rotation (radians) that turns a right-pointing arrow into each lane's direction. */
const LANE_ANGLE = [Math.PI, Math.PI / 2, -Math.PI / 2, 0]

interface Bokeh {
  x: number
  y: number
  r: number
  speed: number
  hue: number
  phase: number
}

export class PlayfieldRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private settings: RenderSettings
  private particles = new ParticleSystem()
  private timing = TimingMap.single(120, 0)
  private noteColor = new Map<string, string>()
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
  private holdOkAt = [-1e9, -1e9, -1e9, -1e9]
  private flash: JudgmentFlash | null = null
  private lastCombo = 0
  private comboBumpAt = -1e9
  private bokeh: Bokeh[] = []

  /* ------------------------------------------------------------------ caches
   * Everything below is rebuilt lazily and only when the geometry or the skin changes, so the
   * steady-state per-frame cost is drawing, not allocating. */
  private layoutCache: PlayfieldLayout | null = null
  private layoutKey = ''
  private spriteCache = new Map<string, HTMLCanvasElement>()
  private skyCache: { key: string; gradient: CanvasGradient } | null = null
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

  constructor(canvas: HTMLCanvasElement, settings: RenderSettings = DEFAULT_RENDER_SETTINGS) {
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas 2D is not available in this browser.')
    this.canvas = canvas
    this.ctx = ctx
    this.settings = { ...settings }
    for (let i = 0; i < 28; i++) {
      this.bokeh.push({
        x: Math.random(),
        y: Math.random(),
        r: 0.02 + Math.random() * 0.06,
        speed: 0.015 + Math.random() * 0.05,
        hue: Math.random() * 360,
        phase: Math.random() * Math.PI * 2,
      })
    }
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
    if (!chart) return
    this.timing = new TimingMap(chart.timing)
    this.noteColor.clear()
    for (const note of chart.notes) this.noteColor.set(note.id, quantColor(this.timing.timeToBeat(note.time)))
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
    const color = JUDGE_STYLE[judgment].glow
    this.explosion[lane] = { color, at: performance.now() }
    if (this.settings.reducedMotion) return
    const geometry = this.layout()
    const x = geometry.laneX[lane] + geometry.laneW / 2
    // Particle count follows the adaptive quality level; at minimal it spawns none at all.
    const density = this.quality === 2 ? 1 : this.quality === 1 ? 0.6 : 0
    if (density <= 0) return
    const strength = judgment === 'marvelous' ? 1.4 : judgment === 'perfect' ? 1.25 : judgment === 'great' ? 1 : 0.8
    const count = judgment === 'marvelous' || judgment === 'perfect' ? 22 : judgment === 'great' ? 14 : 9
    this.particles.burst(x, geometry.receptorY, color, { count: Math.round(count * density), strength })
  }

  /** A hold reached its tail with the key still down: StepMania's OK. */
  holdComplete(lane: Lane): void {
    this.holdOkAt[lane] = performance.now()
    this.explosion[lane] = { color: '#ffe066', at: performance.now() }
    if (this.settings.reducedMotion || this.quality === 0) return
    const geometry = this.layout()
    this.particles.burst(geometry.laneX[lane] + geometry.laneW / 2, geometry.receptorY, '#ffe066', { count: 18, strength: 1.3 })
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
  }

  private layout(): PlayfieldLayout {
    // Leave room for touch thumbs and for wide monitors: the playfield is a centred column.
    const key = `${this.width}x${this.height}:${this.dpr}:${this.settings.scrollSpeed}:${this.settings.noteScale}:${this.settings.scrollDirection}`
    const cached = this.layoutCache
    if (cached && this.layoutKey === key) return cached
    const laneAreaW = Math.max(180, Math.min(this.width * 0.72, 460))
    const laneW = laneAreaW / 4
    const laneAreaX = (this.width - laneAreaW) / 2
    const direction: 1 | -1 = this.settings.scrollDirection === 'down' ? -1 : 1
    const noteH = Math.min(laneW * 0.96, laneW * 0.66 * this.settings.noteScale)
    // The receptor inset mirrors between layouts: at the top for rising arrows, at the bottom
    // for falling ones, so touch-thumb room and HUD clearance are the same either way.
    const inset = Math.max(96, Math.min(this.height * 0.16, 150), 64 + noteH / 2)
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
    // 1 on the beat, decaying over it: the heartbeat every pulse in the scene follows.
    const pulse = reduced ? 0 : Math.exp(-beatFrac * 5)

    this.drawBackground(songSeconds, beat, pulse, dtMs)
    this.drawLanes()
    this.drawReceptors(pulse)
    this.drawNotes(session, songTimeMs, beat)
    this.drawExplosions()
    if (!reduced && this.quality > 0) this.particles.draw(ctx)
    this.drawHoldOk()
    this.drawJudgmentFlash()
    this.drawCombo(hud)
    this.drawHud(hud, pulse)
    this.drawCountdown(hud)
  }

  /* ------------------------------------------------------------- background */

  private drawBackground(songSeconds: number, beat: number, pulse: number, dtMs: number): void {
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
    const bar = Math.floor(beat / 4)
    const hue = (songSeconds * 14 + bar * 47) % 360

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'

    // A wash of colour that swells on every beat and drifts around the colour wheel.
    const glow = ctx.createRadialGradient(w / 2, h * 0.62, 0, w / 2, h * 0.62, Math.max(w, h) * 0.75)
    glow.addColorStop(0, `hsla(${hue}, 95%, 58%, ${0.1 + pulse * 0.16})`)
    glow.addColorStop(0.55, `hsla(${(hue + 60) % 360}, 95%, 50%, ${0.04 + pulse * 0.05})`)
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
        beam.addColorStop(0, `hsla(${lightHue}, 100%, 70%, ${0.1 + pulse * 0.08})`)
        beam.addColorStop(1, 'hsla(0, 0%, 0%, 0)')
        ctx.fillStyle = beam
        ctx.beginPath()
        ctx.moveTo(originX, -10)
        ctx.lineTo(tipX1, tipY1)
        ctx.lineTo(tipX2, tipY2)
        ctx.closePath()
        ctx.fill()
      }

      // A ring that rolls out from the middle on every downbeat.
      const barFrac = (beat / 4) - Math.floor(beat / 4)
      if (beat >= 0) {
        const radius = Math.max(w, h) * 0.08 + barFrac * Math.max(w, h) * 0.7
        ctx.strokeStyle = `hsla(${(hue + 180) % 360}, 100%, 65%, ${0.22 * (1 - barFrac)})`
        ctx.lineWidth = 3 + 10 * (1 - barFrac)
        ctx.beginPath()
        ctx.arc(w / 2, h * 0.55, radius, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // Soft lights floating through the scene, brightening on the beat.
    const step = dtMs / 1000
    const travel = this.settings.scrollDirection === 'down' ? 1 : -1
    for (const light of this.bokeh) {
      light.y += travel * light.speed * step * (1 + pulse * 0.6)
      if (light.y < -0.1) light.y += 1.2
      if (light.y > 1.1) light.y -= 1.2
      const radius = light.r * Math.max(w, h)
      const lightHue = (Math.round(((light.hue + hue) % 360) / 30) * 30) % 360
      const sprite = this.glowSprite(`hsl(${lightHue}, 100%, 65%)`, 48)
      ctx.globalAlpha = 0.12 + pulse * 0.12 + Math.sin(songSeconds * 1.3 + light.phase) * 0.05
      const size = radius * 2
      ctx.drawImage(sprite, light.x * w - radius, light.y * h - radius, size, size)
    }
    ctx.restore()
  }

  private drawLanes(): void {
    const ctx = this.ctx
    const palette = PALETTES[this.settings.theme]
    const { laneX, laneW, laneAreaX, laneAreaW, receptorY, direction, noteH } = this.layout()
    ctx.fillStyle = palette.lanePanel
    ctx.fillRect(laneAreaX, 0, laneAreaW, this.height)
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
    // Neon edge rails.
    ctx.fillStyle = hexToRgba(palette.accent, 0.55)
    ctx.fillRect(laneAreaX - 2, 0, 2, this.height)
    ctx.fillStyle = hexToRgba(palette.accent2, 0.55)
    ctx.fillRect(laneAreaX + laneAreaW, 0, 2, this.height)

    // A beam shoots up the lane from a pressed receptor and fades after release.
    if (this.settings.reducedMotion) return
    for (let lane = 0; lane < 4; lane++) {
      const held = this.laneHeld[lane]
      const fade = held ? 1 : Math.max(0, 1 - (this.nowMs - this.releaseAt[lane]) / 180)
      if (fade <= 0) continue
      const length = (direction === 1 ? this.height - receptorY : receptorY) * 0.42
      const start = receptorY - direction * noteH * 0.2
      const end = receptorY + direction * length
      const beam = ctx.createLinearGradient(0, start, 0, end)
      beam.addColorStop(0, `rgba(255,255,255,${0.2 * fade})`)
      beam.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = beam
      ctx.fillRect(laneX[lane] + 2, Math.min(start, end), laneW - 4, Math.abs(end - start))
    }
  }

  /* ---------------------------------------------------------------- notes */

  private drawReceptors(pulse: number): void {
    const ctx = this.ctx
    const { laneX, laneW, receptorY, noteH } = this.layout()
    for (let lane = 0; lane < 4; lane++) {
      const x = laneX[lane] + laneW / 2
      // StepMania's receptor: brightens on each beat, dips to 85% when pressed and springs back.
      const sincePress = this.nowMs - this.pressAt[lane]
      const squash = sincePress < 110 ? 0.85 + 0.15 * (sincePress / 110) : 1
      const size = noteH * squash
      const sprite = this.noteSprite('receptor', '#ffffff', lane as Lane, noteH)
      ctx.globalAlpha = 0.78 + 0.22 * pulse
      drawCentered(ctx, sprite, x, receptorY, size)
      ctx.globalAlpha = 1

      // The press overlay: a bright copy that settles at 40% while held and swells away on release.
      let overlay = 0
      let zoom = 1
      if (this.laneHeld[lane]) {
        overlay = sincePress < 200 ? 0.8 - 0.4 * (sincePress / 200) : 0.4
      } else {
        const sinceRelease = this.nowMs - this.releaseAt[lane]
        if (sinceRelease < 200) {
          const t = sinceRelease / 200
          overlay = 0.4 * (1 - t)
          zoom = 1 + 0.2 * t
        }
      }
      if (overlay > 0) {
        const flash = this.noteSprite('flash', '#ffffff', lane as Lane, noteH)
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = overlay
        drawCentered(ctx, flash, x, receptorY, size * zoom)
        ctx.restore()
      }
    }
  }

  private drawNotes(session: GameSession, songTimeMs: number, beat: number): void {
    const ctx = this.ctx
    const { laneX, laneW, receptorY, noteH, pxPerSec, travelSeconds, direction } = this.layout()
    const untilMs = songTimeMs + travelSeconds * 1000
    const reduced = this.settings.reducedMotion
    // The arrows shimmer with the beat, like StepMania's animated note skin.
    const beatFrac = beat - Math.floor(beat)
    const shimmer = reduced ? 0 : Math.max(0, 1 - beatFrac * 4) * 0.35

    // Holds already being played: the head stays pinned on the receptor while the body drains.
    session.forEachActiveHold(songTimeMs, (note, life) => {
      const duration = note.duration ?? 0
      if (duration <= 0.05) return
      const tailDeltaMs = (note.time + duration) * 1000 - songTimeMs
      if (tailDeltaMs < 0) return
      const x = laneX[note.lane] + laneW / 2
      const tailY = receptorY + direction * (tailDeltaMs / 1000) * pxPerSec
      const color = this.noteColor.get(note.id) ?? OFF_GRID_COLOR
      const held = life >= 1
      this.drawHoldBody(x, receptorY, tailY, noteH, color, held ? 'active' : 'dropping', life)
      const sprite = this.noteSprite('note', held ? color : '#8a8f9c', note.lane, noteH)
      ctx.globalAlpha = held ? 1 : 0.4 + 0.6 * life
      drawCentered(ctx, sprite, x, receptorY, noteH)
      ctx.globalAlpha = 1
      if (held && !reduced && this.quality > 0) this.drawHoldGlow(x, receptorY, noteH, color, note.lane)
    })

    session.forEachPending(untilMs, (note: ChartNote) => {
      const delta = note.time * 1000 - songTimeMs
      const y = receptorY + direction * (delta / 1000) * pxPerSec
      const x = laneX[note.lane] + laneW / 2
      const color = this.noteColor.get(note.id) ?? OFF_GRID_COLOR
      if (note.kind === 'hold' && note.duration && note.duration > 0.05) {
        const tailY = receptorY + direction * ((delta + note.duration * 1000) / 1000) * pxPerSec
        this.drawHoldBody(x, y, tailY, noteH, color, 'waiting', 1)
      }
      if (direction === 1 ? y > this.height + noteH || y < -noteH : y < -noteH || y > this.height + noteH) return
      const sprite = this.noteSprite('note', color, note.lane, noteH)
      drawCentered(ctx, sprite, x, y, noteH)
      if (shimmer > 0.01) {
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = shimmer
        drawCentered(ctx, this.noteSprite('flash', '#ffffff', note.lane, noteH), x, y, noteH)
        ctx.restore()
      }
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
    const base = state === 'dropping' ? '#7d8291' : color
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

  /** The flickering glow on a receptor while its hold is down (StepMania's hold explosion). */
  private drawHoldGlow(x: number, y: number, noteH: number, color: string, lane: Lane): void {
    const ctx = this.ctx
    const flicker = 0.55 + 0.35 * Math.abs(Math.sin(this.nowMs / 32))
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = flicker
    const glow = this.glowSprite(color, Math.round(noteH))
    drawCentered(ctx, glow, x, y, noteH * 2.1)
    ctx.globalAlpha = 0.5 * flicker
    drawCentered(ctx, this.noteSprite('flash', '#ffffff', lane, noteH), x, y, noteH * 0.95)
    ctx.restore()
    if (this.quality === 2 && Math.random() < 0.45) {
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
      if (age > 600) {
        this.explosion[lane] = null
        continue
      }
      // Full brightness for 100 ms, then a decelerating fade (StepMania's tap explosion timing).
      const fade = age < 100 ? 1 : 1 - easeOut((age - 100) / 500)
      const grow = this.settings.reducedMotion ? 1 : 1 + 0.35 * easeOut(Math.min(1, age / 300))
      const x = laneX[lane] + laneW / 2
      ctx.globalAlpha = fade
      drawCentered(ctx, this.glowSprite(blast.color, Math.round(noteH)), x, receptorY, noteH * 2 * grow)
      ctx.globalAlpha = Math.max(0, 1 - age / 160)
      drawCentered(ctx, this.noteSprite('flash', '#ffffff', lane as Lane, noteH), x, receptorY, noteH * grow)
    }
    ctx.restore()
  }

  private drawHoldOk(): void {
    const ctx = this.ctx
    const { laneX, laneW, receptorY, noteH, direction } = this.layout()
    for (let lane = 0; lane < 4; lane++) {
      const age = this.nowMs - this.holdOkAt[lane]
      if (age > 650) continue
      const zoom = age < 90 ? 1.4 - 0.4 * (age / 90) : 1
      const alpha = age < 450 ? 1 : 1 - (age - 450) / 200
      const x = laneX[lane] + laneW / 2
      const y = receptorY + direction * (noteH * 0.95)
      ctx.save()
      ctx.translate(x, y)
      ctx.scale(zoom, zoom)
      ctx.globalAlpha = Math.max(0, alpha)
      drawStyledText(ctx, 'OK', 0, 0, 20, { top: '#fff7c2', bottom: '#ffc400', glow: '#ffb300' }, this.quality === 2)
      ctx.restore()
    }
  }

  /* ---------------------------------------------------------------- sprites */

  /** Cached arrow tile: 'note' is the coloured arrow, 'receptor' the grey target, 'flash' white. */
  private noteSprite(kind: 'note' | 'receptor' | 'flash', color: string, lane: Lane, size: number): HTMLCanvasElement {
    const shape = this.settings.noteShape
    const key = `${kind}|${color}|${kind === 'flash' && shape === 'orb' ? 0 : lane}|${shape}|${Math.round(size)}`
    const cached = this.spriteCache.get(key)
    if (cached) return cached
    const scale = this.dpr
    const pad = Math.ceil(size * 0.18)
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
      const gradient = ctx.createLinearGradient(0, c - size / 2, 0, c + size / 2)
      gradient.addColorStop(0, shade(color, 0.55))
      gradient.addColorStop(0.45, color)
      gradient.addColorStop(1, shade(color, -0.5))
      ctx.fillStyle = gradient
      ctx.fill(path)
      // Gloss across the upper half.
      ctx.save()
      ctx.clip(path)
      const gloss = ctx.createLinearGradient(0, c - size / 2, 0, c)
      gloss.addColorStop(0, 'rgba(255,255,255,0.45)')
      gloss.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = gloss
      ctx.fillRect(0, 0, box, c)
      ctx.restore()
      ctx.lineWidth = Math.max(2, size * 0.075)
      ctx.strokeStyle = '#0a0716'
      ctx.stroke(path)
      ctx.lineWidth = Math.max(1, size * 0.028)
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'
      ctx.stroke(path)
    } else if (kind === 'receptor') {
      ctx.fillStyle = 'rgba(14, 12, 30, 0.75)'
      ctx.fill(path)
      ctx.lineWidth = Math.max(2, size * 0.09)
      ctx.strokeStyle = '#05040c'
      ctx.stroke(path)
      const rim = ctx.createLinearGradient(0, c - size / 2, 0, c + size / 2)
      rim.addColorStop(0, '#ffffff')
      rim.addColorStop(1, '#8d93a8')
      ctx.lineWidth = Math.max(1.5, size * 0.045)
      ctx.strokeStyle = rim
      ctx.stroke(path)
    } else {
      ctx.shadowColor = 'rgba(255,255,255,0.9)'
      ctx.shadowBlur = size * 0.18 * scale
      ctx.fillStyle = 'rgba(255,255,255,0.95)'
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
    drawStyledText(ctx, text, 0, 0, Math.min(34, laneAreaW / 8.5), JUDGE_STYLE[flash.judgment], this.quality === 2)
    ctx.restore()
    if (flash.judgment !== 'miss' && Math.abs(flash.deltaMs) >= 3) {
      ctx.save()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.globalAlpha = Math.max(0, alpha) * 0.8
      ctx.font = `700 12px ${FONT}`
      ctx.fillStyle = flash.deltaMs > 0 ? '#ffb3a6' : '#a6d8ff'
      ctx.fillText(`${flash.deltaMs > 0 ? 'LATE' : 'EARLY'} ${Math.abs(flash.deltaMs).toFixed(0)} ms`, x, y + 24)
      ctx.restore()
    }
  }

  private drawCombo(hud: HudState): void {
    if (hud.combo < 3) return
    const ctx = this.ctx
    const { laneAreaX, laneAreaW } = this.layout()
    const x = laneAreaX + laneAreaW / 2
    const y = this.judgmentY() + 62
    const sinceBump = this.nowMs - this.comboBumpAt
    const zoom = this.settings.reducedMotion ? 1 : sinceBump < 120 ? 1.18 - 0.18 * (sinceBump / 120) : 1
    const hot = hud.combo >= 100
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(zoom, zoom)
    drawStyledText(
      ctx,
      String(hud.combo),
      0,
      0,
      48,
      hot ? { top: '#fff6c4', bottom: '#ffb300', glow: '#ff9d00' } : { top: '#ffffff', bottom: '#b8f2ff', glow: '#3fd8ff' },
      this.quality === 2,
    )
    ctx.restore()
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `italic 800 13px ${FONT}`
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.fillText('COMBO', x, y + 34)
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

  private drawHud(hud: HudState, pulse: number): void {
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
        ctx.fillStyle = `rgba(255,255,255,${0.6 + pulse * 0.4})`
        ctx.fillRect(x + w * progress - 2, y - 1, 3, h + 2)
      }
    }

    if (laneAreaX >= 180) {
      // Wide screens: two columns hugging the highway, score on the left, the song on the right.
      const leftX = laneAreaX - 30
      const rightX = laneAreaX + laneAreaW + 30
      const top = 76
      ctx.textAlign = 'right'
      ctx.font = `italic 800 12px ${FONT}`
      ctx.fillStyle = palette.hudMuted
      ctx.fillText('SCORE', leftX, top)
      ctx.font = `italic 900 32px ${FONT}`
      ctx.fillStyle = palette.hudText
      ctx.shadowColor = palette.accent
      ctx.shadowBlur = this.quality === 2 ? 12 : 0
      ctx.fillText(this.scoreTextCache.text, leftX, top + 16)
      ctx.shadowBlur = 0
      ctx.font = `italic 800 12px ${FONT}`
      ctx.fillStyle = palette.hudMuted
      ctx.fillText('ACCURACY', leftX, top + 66)
      ctx.font = `italic 900 24px ${FONT}`
      ctx.fillStyle = palette.hudText
      ctx.fillText(this.accuracyTextCache.text, leftX, top + 82)

      ctx.textAlign = 'left'
      const columnW = Math.min(220, this.width - rightX - 24)
      if (hud.title) {
        ctx.font = `800 17px ${FONT}`
        ctx.fillStyle = palette.hudText
        ctx.fillText(this.fitTitle(hud.title, columnW), rightX, top)
      }
      if (hud.subtitle) {
        ctx.font = `italic 900 13px ${FONT}`
        ctx.fillStyle = palette.accent
        ctx.fillText(hud.subtitle, rightX, top + 26)
      }
      progressBar(rightX, top + 52, columnW, 5)
    } else {
      // Narrow screens: one compact row above the receptors, below the pause/fullscreen buttons.
      const y = 50
      ctx.font = `italic 900 21px ${FONT}`
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

  private drawCountdown(hud: HudState): void {
    if (hud.countdownMs === null) return
    const remaining = hud.countdownMs
    const number = Math.ceil(Math.max(0, remaining) / 1000)
    const ctx = this.ctx
    const phase = 1 - ((Math.max(0, remaining) % 1000) / 1000) // 0 → just appeared
    const reduced = this.settings.reducedMotion
    const scale = reduced ? 1 : 1 + (1 - Math.min(1, phase * 3)) * 0.45
    const x = this.width / 2
    const y = this.height * 0.42
    ctx.save()
    if (!reduced) {
      ctx.globalCompositeOperation = 'lighter'
      ctx.strokeStyle = `rgba(255, 79, 216, ${0.5 * (1 - phase)})`
      ctx.lineWidth = 6
      ctx.beginPath()
      ctx.arc(x, y, 60 + phase * 140, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalCompositeOperation = 'source-over'
    }
    ctx.translate(x, y)
    ctx.scale(scale, scale)
    drawStyledText(
      ctx,
      number > 0 ? String(number) : 'GO!',
      0,
      0,
      104,
      { top: '#ffffff', bottom: '#ffb8f0', glow: '#ff4fd8' },
      this.quality > 0,
    )
    ctx.restore()
  }
}

/* -------------------------------------------------------------------- helpers */

function quantColor(beat: number): string {
  for (const [division, color] of QUANT_COLORS) {
    const scaled = beat * division
    if (Math.abs(scaled - Math.round(scaled)) < 0.02) return color
  }
  return OFF_GRID_COLOR
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

/** Big arcade text: dark outline, vertical gradient fill and an optional coloured glow. */
function drawStyledText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  style: JudgeStyle,
  glow: boolean,
): void {
  ctx.save()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `italic 900 ${Math.round(size)}px ${FONT}`
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(3, size * 0.16)
  ctx.strokeStyle = 'rgba(6, 4, 16, 0.92)'
  if (glow) {
    ctx.shadowColor = style.glow
    ctx.shadowBlur = size * 0.45
  }
  ctx.strokeText(text, x, y)
  ctx.shadowBlur = 0
  const gradient = ctx.createLinearGradient(0, y - size / 2, 0, y + size / 2)
  gradient.addColorStop(0, style.top)
  gradient.addColorStop(1, style.bottom)
  ctx.fillStyle = gradient
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
