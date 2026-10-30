/**
 * Canvas playfield renderer.
 *
 * Contract with the rest of the game:
 *  - It never reads the clock itself and never decides anything about judgement. The caller
 *    passes the audible song time (milliseconds) every frame, and the renderer draws the world
 *    for that instant.
 *  - It reads pending notes through `GameSession.forEachPending`, so judged notes disappear the
 *    moment they are judged and drawing stays O(visible notes).
 *  - Everything decorative (particles, shake, pulse) is skipped when reduced motion is on.
 */
import type { ChartNote, HitEvent, Judgment, Lane } from '../core/types'
import { LANE_INFO } from '../core/types'
import { JUDGMENT_COLOR, JUDGMENT_LABEL } from '../game/judgment'
import type { GameSession } from '../game/session'
import { ParticleSystem } from './particles'

export type LaneStyle = 'neon' | 'classic' | 'minimal'
/** Note skin: the thick default arrow, a vector chevron, a diamond, or a plain bar. */
export type NoteShape = 'arrow' | 'chevron' | 'diamond' | 'orb' | 'star' | 'hex' | 'bar'
/** 'up' = arcade layout (targets at the top, arrows rise); 'down' = classic falling arrows. */
export type ScrollDirection = 'up' | 'down'
/** Whole-app skin: the flat default look or the original cooler variant. */
export type ThemeName = 'neon' | 'disco'

export interface RenderSettings {
  /** 1 (slow) … 10 (fast). Converted to pixels per second using the travel distance. */
  scrollSpeed: number
  /** One multiplier for tap notes, hold notes and receptors, 0.8…1.7. */
  noteScale: number
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

/** Flat playfield colours per theme; the DOM uses the matching CSS variables. */
interface PlayfieldPalette {
  background: string
  hudText: string
  hudMuted: string
  hudFaint: string
  accent: string
}

const PALETTES: Record<ThemeName, PlayfieldPalette> = {
  neon: {
    background: '#0b0b0d',
    hudText: '#f3f5f7',
    hudMuted: '#b6bec8',
    hudFaint: '#8a939e',
    accent: '#56b4e9',
  },
  disco: {
    background: '#0b0b0d',
    hudText: '#f3f5f7',
    hudMuted: '#b6bec8',
    hudFaint: '#8a939e',
    accent: '#56b4e9',
  },
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
}

interface JudgmentFlash {
  judgment: Judgment
  lane: Lane
  deltaMs: number
  ageMs: number
  combo: number
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

// One monospace face everywhere, including the canvas HUD.
const FONT = 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, "Courier New", monospace'

/** Rotation (radians) that turns a right-pointing chevron into each lane's arrow direction. */
const LANE_ANGLE = [Math.PI, Math.PI / 2, -Math.PI / 2, 0]

export class PlayfieldRenderer {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private settings: RenderSettings
  private particles = new ParticleSystem()
  private lanePress = [0, 0, 0, 0]
  private flash: JudgmentFlash | null = null
  private lastFrameMs = 0
  private width = 0
  private height = 0
  private dpr = 1

  /* ------------------------------------------------------------------ caches
   * Everything below is rebuilt lazily and only when the geometry or the skin changes, so the
   * steady-state per-frame cost is drawing, not allocating. */
  private layoutCache: PlayfieldLayout | null = null
  private layoutKey = ''
  private shapePathCache = new Map<string, Path2D>()
  private scoreTextCache = { value: -1, text: '' }
  private accuracyTextCache = { value: -1, text: '' }

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
  }

  setSettings(settings: Partial<RenderSettings>): void {
    this.settings = { ...this.settings, ...settings }
    this.invalidateCaches()
  }

  getSettings(): RenderSettings {
    return { ...this.settings }
  }

  /** Clear transient effects so nothing leaks between songs. */
  setChart(durationSeconds: number): void {
    void durationSeconds
    this.particles.clear()
    this.flash = null
    this.lanePress = [0, 0, 0, 0]
  }

  press(lane: Lane): void {
    this.lanePress[lane] = 1
  }

  release(lane: Lane): void {
    this.lanePress[lane] = 0
  }

  /** A judgement happened: show the word and a small flat particle burst. */
  notify(event: HitEvent, combo: number): void {
    const { lane, judgment } = event
    const color = JUDGMENT_COLOR[judgment]
    this.flash = { judgment, lane, deltaMs: event.deltaMs, ageMs: 0, combo, ...(event.holdDrop ? { holdDrop: true } : {}) }
    if (this.settings.reducedMotion) return
    const geometry = this.layout()
    const x = geometry.laneX[lane] + geometry.laneW / 2
    const y = geometry.receptorY + geometry.noteH / 2
    // Particle count follows the adaptive quality level; at minimal it spawns none at all.
    const density = this.quality === 2 ? 1 : this.quality === 1 ? 0.6 : 0
    if (density <= 0) return
    if (judgment === 'miss') {
      this.particles.burst(x, y, color, { count: Math.round(10 * density), strength: 0.5, downward: true })
    } else {
      const strength = judgment === 'perfect' ? 1.35 : judgment === 'great' ? 1.1 : judgment === 'good' ? 0.9 : 0.7
      const count = judgment === 'perfect' ? 22 : judgment === 'great' ? 16 : judgment === 'good' ? 12 : 8
      this.particles.burst(x, y, color, { count: Math.round(count * density), strength, spread: judgment === 'perfect' ? 1.1 : 0.9 })
    }
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
    this.shapePathCache.clear()
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
    // The receptor inset mirrors between layouts: at the top for rising arrows, at the bottom
    // for falling ones, so touch-thumb room and HUD clearance are the same either way.
    const inset = Math.max(96, Math.min(this.height * 0.16, 150))
    const receptorY = direction === 1 ? inset : this.height - inset
    const noteH = Math.max(16, laneW * 0.3 * this.settings.noteScale)
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
      travelSeconds: travelDistance / Math.max(1, pxPerSec),
      direction,
    }
    this.layoutCache = layout
    this.layoutKey = key
    return layout
  }

  render(session: GameSession, songTimeMs: number, hud: HudState): void {
    const ctx = this.ctx
    // The backing store is devicePixelRatio-scaled; draw in logical pixels. Setting the transform
    // every frame is a no-op for canvas cost and guarantees correctness after a resize (which
    // resets the transform). Without this, the playfield is cropped/zoomed on HiDPI displays.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const now = performance.now()
    const dtMs = this.lastFrameMs === 0 ? 16 : Math.min(now - this.lastFrameMs, 80)
    this.lastFrameMs = now
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
    if (!reduced && this.quality > 0) this.particles.update(dtMs)

    this.drawBackground()
    this.drawLanes()
    this.drawNotes(session, songTimeMs)
    this.drawReceptors()
    if (!reduced && this.quality > 0) this.particles.draw(this.ctx)
    this.drawJudgmentFlash()
    this.drawHud(hud)
    this.drawCountdown(hud)
  }

  private drawBackground(): void {
    this.ctx.fillStyle = PALETTES[this.settings.theme].background
    this.ctx.fillRect(0, 0, this.width, this.height)
  }

  private drawLanes(): void {
    const ctx = this.ctx
    const { laneX, laneW, laneAreaX, laneAreaW } = this.layout()
    const style = this.settings.laneStyle
    // Flat lane beds. No gradients, no pulsing, no hit shine: only a constant tint and a thin
    // vertical separator keep the four columns legible.
    const tint = style === 'minimal' ? 0 : style === 'classic' ? 0.04 : 0.065
    for (let lane = 0; lane < 4; lane++) {
      const x = laneX[lane]
      if (tint > 0) {
        ctx.fillStyle = hexToRgba(LANE_INFO[lane].color, tint)
        ctx.fillRect(x, 0, laneW, this.height)
      }
      ctx.fillStyle = 'rgba(255,255,255,0.08)'
      ctx.fillRect(x, 0, 1, this.height)
      if (this.lanePress[lane] > 0) {
        ctx.fillStyle = hexToRgba(LANE_INFO[lane].color, 0.06)
        ctx.fillRect(x + 1, 0, laneW - 1, this.height)
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.fillRect(laneAreaX + laneAreaW - 1, 0, 1, this.height)
  }

  private drawNotes(session: GameSession, songTimeMs: number): void {
    const { laneX, laneW, receptorY, noteH, pxPerSec, travelSeconds, direction } = this.layout()
    const noteW = laneW * 0.84
    const untilMs = songTimeMs + travelSeconds * 1000
    const drawNote = (note: ChartNote): void => {
      const delta = note.time * 1000 - songTimeMs
      if (delta > travelSeconds * 1000) return
      const y = receptorY + direction * (delta / 1000) * pxPerSec
      if (direction === 1 ? y > this.height + noteH * 2 || y < -noteH : y < -noteH * 2 || y > this.height + noteH) return
      const x = laneX[note.lane] + (laneW - noteW) / 2
      if (note.kind === 'hold' && note.duration && note.duration > 0.05) {
        // The tail sits further in the future, so it extends toward the spawn edge.
        const tailCenterY = receptorY + direction * ((delta + note.duration * 1000) / 1000) * pxPerSec
        this.drawHoldTail(x, y, tailCenterY, noteW, noteH, note.lane)
      }
      this.drawNoteBody(x, y - noteH / 2, noteW, noteH, note.lane)
    }
    session.forEachPending(untilMs, drawNote)
    // Holds whose head was already judged still need their shaft on screen. It is anchored at the
    // receptors (the head has passed them) and dims while the key is released — StepMania's hold
    // life — so the player can see that letting go is destroying the hold and re-pressing saves it.
    session.forEachActiveHold(songTimeMs, (note, life) => {
      const duration = note.duration ?? 0
      if (duration <= 0.05) return
      const tailDeltaMs = (note.time + duration) * 1000 - songTimeMs
      if (tailDeltaMs < -noteH) return
      const x = laneX[note.lane] + (laneW - noteW) / 2
      const tailCenterY = receptorY + direction * (tailDeltaMs / 1000) * pxPerSec
      this.drawHoldTail(x, receptorY, tailCenterY, noteW, noteH, note.lane, 0.35 + 0.65 * life)
    })
  }

  /**
   * A hold is one long arrow: the same vector arrow at the tail, joined to the head by a thin
   * flat shaft. No rounded cap, no glow, no filled bar — the silhouette matches a tap exactly.
   */
  private drawHoldTail(
    x: number,
    headCenterY: number,
    tailCenterY: number,
    w: number,
    noteH: number,
    lane: Lane,
    alpha = 1,
  ): void {
    const ctx = this.ctx
    const color = LANE_INFO[lane].color
    const barW = Math.max(3, w * 0.075)
    const cx = x + w / 2
    const top = Math.min(headCenterY, tailCenterY)
    const bottom = Math.max(headCenterY, tailCenterY)
    const height = Math.max(1, bottom - top)
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = hexToRgba(color, 0.55)
    ctx.fillRect(cx - barW / 2, top, barW, height)
    ctx.restore()
    this.drawArrowShape(cx, tailCenterY, w, noteH, lane, alpha)
  }

  private drawNoteBody(x: number, y: number, w: number, h: number, lane: Lane): void {
    const ctx = this.ctx
    const shape = this.settings.noteShape
    const color = LANE_INFO[lane].color
    ctx.save()
    ctx.translate(x, y)
    if (shape === 'arrow') {
      this.drawArrowBody(w, h, lane)
      ctx.restore()
      return
    }
    if (shape === 'bar') {
      ctx.fillStyle = color
      ctx.fillRect(0, 0, w, h)
      ctx.strokeStyle = 'rgba(255,255,255,0.65)'
      ctx.lineWidth = 1.5
      ctx.strokeRect(0.75, 0.75, w - 1.5, h - 1.5)
      ctx.restore()
      return
    }
    // The note *is* the arrow — a lane-coloured silhouette that matches its receptor. A thin
    // white rim keeps the edge crisp against the lane bed without adding glow.
    const path = this.shapePath(shape, w, h)
    ctx.translate(w / 2, h / 2)
    ctx.rotate(LANE_ANGLE[lane])
    ctx.translate(-w / 2, -h / 2)
    ctx.fillStyle = color
    ctx.fill(path)
    ctx.lineWidth = 1.5
    ctx.strokeStyle = 'rgba(255,255,255,0.65)'
    ctx.stroke(path)
    ctx.restore()
  }

  /**
   * The default arrow skin: one thick vector arrow, identical in construction to every other note
   * shape and to the receptor ghost. Nothing is rasterised from a font, so large sizes stay crisp.
   */
  private drawArrowBody(w: number, h: number, lane: Lane): void {
    this.drawArrowShape(w / 2, h / 2, w, h, lane)
  }

  /**
   * Draw the thick vector arrow centred on a point. `w` × `h` is the complete bounding box, and
   * tap notes, hold tails and receptors all pass the same dimensions, so the three never drift.
   */
  private drawArrowShape(
    centerX: number,
    centerY: number,
    w: number,
    h: number,
    lane: Lane,
    alpha = 1,
    fillAlpha = 1,
    strokeAlpha = 0.9,
  ): void {
    const ctx = this.ctx
    ctx.save()
    ctx.translate(centerX, centerY)
    ctx.rotate(LANE_ANGLE[lane])
    ctx.translate(-w / 2, -h / 2)
    const path = this.arrowPath(w, h)
    ctx.globalAlpha = alpha * fillAlpha
    ctx.fillStyle = LANE_INFO[lane].color
    ctx.fill(path)
    ctx.globalAlpha = alpha * strokeAlpha
    ctx.lineJoin = 'miter'
    ctx.lineWidth = Math.max(1.5, Math.min(w, h) * 0.045)
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'
    ctx.stroke(path)
    ctx.restore()
  }

  /** Cached thick-arrow silhouette pointing right, occupying the whole w × h box. */
  private arrowPath(w: number, h: number): Path2D {
    const key = `arrow|${Math.round(w)}|${Math.round(h)}`
    const cached = this.shapePathCache.get(key)
    if (cached) return cached
    const path = new Path2D()
    // Shaft plus a full-height head. The shaft is 40% of the tile height, which reads as a solid
    // arcade arrow rather than a thin glyph.
    path.moveTo(w * 0.04, h * 0.3)
    path.lineTo(w * 0.52, h * 0.3)
    path.lineTo(w * 0.52, h * 0.04)
    path.lineTo(w * 0.98, h * 0.5)
    path.lineTo(w * 0.52, h * 0.96)
    path.lineTo(w * 0.52, h * 0.7)
    path.lineTo(w * 0.04, h * 0.7)
    path.closePath()
    this.shapePathCache.set(key, path)
    return path
  }

  /**
   * Cached vector silhouettes for the note skins. Each shape is traced once per size into a
   * `Path2D` pointing right; every lane then rotates it into place with a canvas transform, so a
   * frame only ever pays for fill/stroke — no per-note path building, no text rasterisation.
   */
  private shapePath(shape: Exclude<NoteShape, 'bar'>, w: number, h: number): Path2D {
    const key = `${shape}|${Math.round(w)}|${Math.round(h)}`
    const cached = this.shapePathCache.get(key)
    if (cached) return cached
    const path = new Path2D()
    const cy = h / 2
    const inset = Math.min(w * 0.045, h * 0.14)
    const left = inset
    const right = w - inset
    if (shape === 'arrow') {
      // Classic block arrow: notched tail, full-height head.
      const base = right - Math.min(h * 1.05, w * 0.42)
      const tail = h * 0.24
      const barb = h * 0.5
      path.moveTo(left, cy - tail)
      path.lineTo(base, cy - tail)
      path.lineTo(base, cy - barb)
      path.lineTo(right, cy)
      path.lineTo(base, cy + barb)
      path.lineTo(base, cy + tail)
      path.lineTo(left, cy + tail)
    } else if (shape === 'chevron') {
      // Arrowhead with a notched back — bolder than a thin chevron band in a wide tile.
      path.moveTo(left, cy - h * 0.5)
      path.lineTo(right, cy)
      path.lineTo(left, cy + h * 0.5)
      path.lineTo(left + Math.min(w * 0.4, h * 1.1), cy)
    } else if (shape === 'orb') {
      path.ellipse(w / 2, cy, w * 0.46, h * 0.48, 0, 0, Math.PI * 2)
    } else if (shape === 'star') {
      const outerX = w * 0.48
      const outerY = h * 0.5
      for (let i = 0; i < 10; i++) {
        const radius = i % 2 === 0 ? 1 : 0.44
        const angle = -Math.PI / 2 + (i * Math.PI) / 5
        const x = w / 2 + Math.cos(angle) * outerX * radius
        const y = cy + Math.sin(angle) * outerY * radius
        if (i === 0) path.moveTo(x, y)
        else path.lineTo(x, y)
      }
    } else if (shape === 'hex') {
      for (let i = 0; i < 6; i++) {
        const angle = (i * Math.PI) / 3
        const x = w / 2 + Math.cos(angle) * w * 0.47
        const y = cy + Math.sin(angle) * h * 0.5
        if (i === 0) path.moveTo(x, y)
        else path.lineTo(x, y)
      }
    } else {
      // Diamond — a flat rhombus spanning the tile, so the skin still reads at scroll speed.
      path.moveTo(left, cy)
      path.lineTo(w / 2, cy - h * 0.5)
      path.lineTo(right, cy)
      path.lineTo(w / 2, cy + h * 0.5)
    }
    path.closePath()
    this.shapePathCache.set(key, path)
    return path
  }

  private drawReceptors(): void {
    const ctx = this.ctx
    const { laneX, laneW, receptorY, noteH } = this.layout()
    // Exactly the note height, not a multiple of it: notes, hold tails and targets are one size.
    const h = noteH
    // The target uses the same vector path and the same w × h as a note, so a note and its target
    // overlap exactly at the receptor without one being a different shape or size.
    const arrowSkin = this.settings.noteShape === 'arrow'
    const shape = this.settings.noteShape === 'bar' ? 'arrow' : this.settings.noteShape
    const w = laneW * 0.84
    const path = arrowSkin ? null : this.shapePath(shape, w, h)
    for (let lane = 0; lane < 4; lane++) {
      const info = LANE_INFO[lane]
      const press = this.lanePress[lane]
      if (arrowSkin) {
        this.drawArrowShape(
          laneX[lane] + laneW / 2,
          receptorY,
          w,
          h,
          lane as Lane,
          1,
          0.16 + press * 0.34,
          0.55 + press * 0.35,
        )
        continue
      }
      const x = laneX[lane] + (laneW - w) / 2
      const y = receptorY - h / 2
      ctx.save()
      ctx.translate(x + w / 2, y + h / 2)
      ctx.rotate(LANE_ANGLE[lane])
      ctx.translate(-w / 2, -h / 2)
      // A faint dark backing keeps the hollow target legible over the lane bed.
      ctx.globalAlpha = 0.7
      ctx.fillStyle = 'rgba(8, 9, 11, 0.72)'
      ctx.fill(path!)
      ctx.globalAlpha = 1
      ctx.strokeStyle = hexToRgba(info.color, 0.6 + press * 0.4)
      ctx.lineWidth = 2 + press * 1.5
      ctx.stroke(path!)
      if (press > 0) {
        ctx.fillStyle = hexToRgba(info.color, 0.18 + press * 0.22)
        ctx.fill(path!)
      }
      ctx.restore()
    }
  }

  private drawJudgmentFlash(): void {
    const flash = this.flash
    if (!flash) return
    const { laneX, laneW, receptorY, direction } = this.layout()
    const age = flash.ageMs
    const fade = Math.max(0, 1 - age / 700)
    if (fade <= 0) return
    const ctx = this.ctx
    const color = JUDGMENT_COLOR[flash.judgment]
    const x = laneX[flash.lane] + laneW / 2
    // The text floats away from the receptor into the free area behind it.
    const y = receptorY + direction * (54 + Math.min(30, age * 0.05))
    ctx.save()
    const text = flash.holdDrop ? 'LET GO' : JUDGMENT_LABEL[flash.judgment]
    ctx.font = `800 ${flash.judgment === 'marvelous' ? 21 : flash.judgment === 'perfect' ? 19 : 17}px ${FONT}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.globalAlpha = fade
    ctx.fillStyle = color
    ctx.fillText(text, x, y)
    if (flash.judgment !== 'miss' && Math.abs(flash.deltaMs) >= 3) {
      ctx.globalAlpha = fade * 0.75
      ctx.font = `600 11px ${FONT}`
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.fillText(`${flash.deltaMs > 0 ? '+' : ''}${flash.deltaMs.toFixed(0)} ms`, x, y + 17)
    }
    ctx.restore()
  }

  private drawHud(hud: HudState): void {
    const ctx = this.ctx
    const palette = PALETTES[this.settings.theme]
    ctx.save()
    ctx.textBaseline = 'top'
    // Score, top left. Locale formatting and fixed-decimal strings are cached by value: they only
    // change when the score does, not every frame.
    if (this.scoreTextCache.value !== hud.score) {
      this.scoreTextCache = { value: hud.score, text: hud.score.toLocaleString('en-US') }
    }
    ctx.textAlign = 'left'
    ctx.font = `800 26px ${FONT}`
    ctx.fillStyle = palette.hudText
    // Dropped below the DOM chips (pause / fullscreen) so the score can never sit under them.
    ctx.fillText(this.scoreTextCache.text, 22, 58)
    ctx.font = `600 11px ${FONT}`
    ctx.fillStyle = palette.hudMuted
    ctx.fillText(hud.autoPlay ? 'SCORE · AUTO-PLAY' : 'SCORE', 22, 90)

    // Accuracy, top right.
    const accuracy = Math.round(hud.accuracy * 10000) / 10000
    if (this.accuracyTextCache.value !== accuracy) {
      this.accuracyTextCache = { value: accuracy, text: `${(accuracy * 100).toFixed(2)}%` }
    }
    ctx.textAlign = 'right'
    ctx.font = `800 26px ${FONT}`
    ctx.fillStyle = palette.hudText
    ctx.fillText(this.accuracyTextCache.text, this.width - 22, 58)
    ctx.font = `600 11px ${FONT}`
    ctx.fillStyle = palette.hudMuted
    ctx.fillText('ACCURACY', this.width - 22, 90)
    // Frame rate / quality readout (Settings → Show statistics). Shows the adaptive level so a
    // performance drop is visible instead of felt.
    if (hud.showStats) {
      const fps = this.frameEma > 0 ? Math.min(999, Math.round(1000 / this.frameEma)) : 0
      ctx.textAlign = 'right'
      ctx.font = `600 11px ${FONT}`
      ctx.fillStyle = palette.hudFaint
      ctx.fillText(`${fps} FPS · Q${this.quality + 1}`, this.width - 22, this.height - 30)
      ctx.textAlign = 'left'
    }
    ctx.textAlign = 'left'

    // Combo, left margin — clear of the note path, mirroring the score column.
    if (hud.combo >= 3) {
      ctx.textAlign = 'left'
      const comboY = this.height * 0.46
      const scale = 1 + Math.min(0.12, hud.combo / 1200)
      ctx.save()
      ctx.translate(22, comboY)
      ctx.scale(scale, scale)
      ctx.font = `900 54px ${FONT}`
      ctx.fillStyle = palette.hudText
      ctx.fillText(String(hud.combo), 0, 0)
      ctx.restore()
      ctx.font = `700 12px ${FONT}`
      ctx.fillStyle = palette.hudMuted
      ctx.fillText('COMBO', 22, comboY + 34)
    }

    // Progress bar across the very top: one flat accent, no gradient.
    const barH = 4
    ctx.fillStyle = 'rgba(255,255,255,0.08)'
    ctx.fillRect(0, 0, this.width, barH)
    const progress = Math.max(0, Math.min(1, hud.progress))
    ctx.fillStyle = palette.accent
    ctx.fillRect(0, 0, this.width * progress, barH)
    ctx.restore()
  }

  private drawCountdown(hud: HudState): void {
    if (hud.countdownMs === null) return
    const remaining = hud.countdownMs
    const number = Math.ceil(Math.max(0, remaining) / 1000)
    const ctx = this.ctx
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const phase = 1 - ((Math.max(0, remaining) % 1000) / 1000) // 0 → just appeared
    const scale = this.settings.reducedMotion ? 1 : 1 + (1 - Math.min(1, phase * 3)) * 0.35
    ctx.globalAlpha = 0.9
    ctx.translate(this.width / 2, this.height * 0.42)
    ctx.scale(scale, scale)
    ctx.font = `900 96px ${FONT}`
    ctx.fillStyle = 'rgba(255,255,255,0.96)'
    ctx.fillText(number > 0 ? String(number) : 'GO', 0, 0)
    ctx.restore()
  }
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
