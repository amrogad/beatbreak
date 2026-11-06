/**
 * Circle mode drawing: the field, circles with closing rings, sliders, hit effects and the cursor.
 *
 * Owned by `PlayfieldRenderer`, which keeps the background, HUD and countdown. Everything here is
 * drawn from cached sprites and cached slider paths; a frame only strokes rings and copies images.
 * Portrait screens turn the 4:3 field on its side so circles stay big on phones.
 */
import type { HitEvent, Judgment } from '../core/types'
import { FIELD_H, FIELD_W, sliderBall, sliderExit, type CircleMap, type CircleObject, type CirclePoint } from '../chart/circles'
import type { CircleSession } from '../game/circleSession'

export interface TextStyle {
  fill: string
  shadow: string
  burst: string
}

export interface CircleEnv {
  ctx: CanvasRenderingContext2D
  dpr: number
  nowMs: number
  mono: boolean
  reduced: boolean
  quality: 0 | 1 | 2
  color(slot: number): string
  missColor: string
  judgeStyle(judgment: Judgment): TextStyle
  drawText(text: string, x: number, y: number, size: number, style: TextStyle, glow: boolean): void
  /** The soft round light the arrows use for their hit glow. */
  glow(color: string, radius: number): HTMLCanvasElement
}

export interface FieldRect {
  /** Screen box of the whole field, padding included. */
  x: number
  y: number
  w: number
  h: number
  scale: number
  portrait: boolean
  pad: number
}

interface Effect {
  x: number
  y: number
  color: string
  judgment: Judgment
  at: number
  broke: boolean
  tail: boolean
}

const HIT_FX_MS = 260
const TEXT_FX_MS = 520
/** An early press shakes the circle it landed on for this long. */
const SHAKE_MS = 260
/** A press on nothing leaves a small fading mark for this long. */
const MARK_MS = 280

export class CircleField {
  readonly map: CircleMap
  rect: FieldRect = { x: 0, y: 0, w: 1, h: 1, scale: 1, portrait: false, pad: 0 }
  private layoutKey = ''
  private objectsById = new Map<string, CircleObject>()
  private effects: Effect[] = []
  private sprites = new Map<string, HTMLCanvasElement>()
  private paths = new Map<string, Path2D>()
  private pointer: { x: number; y: number; visible: boolean } = { x: 0, y: 0, visible: false }
  private trail: CirclePoint[] = []
  private shakes = new Map<string, number>()
  private marks: { x: number; y: number; at: number }[] = []

  constructor(map: CircleMap) {
    this.map = map
    for (const object of map.objects) this.objectsById.set(object.id, object)
  }

  /** Fit the field (with room for circles on its edge) between the top bar and the bottom hint. */
  layout(width: number, height: number, dpr: number): FieldRect {
    const key = `${width}x${height}@${dpr}`
    if (key === this.layoutKey) return this.rect
    this.layoutKey = key
    const portrait = height > width * 1.08
    const pad = this.map.radius * 1.15
    const fw = (portrait ? FIELD_H : FIELD_W) + pad * 2
    const fh = (portrait ? FIELD_W : FIELD_H) + pad * 2
    const top = portrait ? 74 : 58
    const bottom = portrait ? 64 : 40
    const availW = width * (portrait ? 0.98 : 0.96)
    const availH = Math.max(100, height - top - bottom)
    const scale = Math.min(availW / fw, availH / fh)
    const w = fw * scale
    const h = fh * scale
    this.rect = { x: (width - w) / 2, y: top + (availH - h) / 2, w, h, scale, portrait, pad }
    this.sprites.clear()
    this.paths.clear()
    return this.rect
  }

  toScreen(fx: number, fy: number): CirclePoint {
    const { x, y, scale, portrait, pad } = this.rect
    return portrait ? { x: x + (FIELD_H + pad - fy) * scale, y: y + (fx + pad) * scale } : { x: x + (fx + pad) * scale, y: y + (fy + pad) * scale }
  }

  toField(sx: number, sy: number): CirclePoint {
    const { x, y, scale, portrait, pad } = this.rect
    return portrait ? { x: (sy - y) / scale - pad, y: FIELD_H + pad - (sx - x) / scale } : { x: (sx - x) / scale - pad, y: (sy - y) / scale - pad }
  }

  setPointer(sx: number, sy: number, visible: boolean): void {
    this.pointer = { x: sx, y: sy, visible }
  }

  reset(): void {
    this.effects = []
    this.trail = []
    this.shakes.clear()
    this.marks = []
  }

  /** A press too early on this circle: it shakes, nothing is scored. */
  shake(object: CircleObject, nowMs: number): void {
    this.shakes.set(object.id, nowMs)
  }

  /** A press that reached no circle: a faint mark where it landed (field units). */
  mark(at: CirclePoint, nowMs: number): void {
    const screen = this.toScreen(at.x, at.y)
    this.marks.push({ x: screen.x, y: screen.y, at: nowMs })
    if (this.marks.length > 12) this.marks.shift()
  }

  /** A judgement happened: an effect where the object was, returned for the particle burst. */
  notify(event: HitEvent, color: string, nowMs: number): CirclePoint | null {
    const tail = event.noteId.endsWith('#tail')
    const object = this.objectsById.get(tail ? event.noteId.slice(0, -5) : event.noteId)
    if (!object) return null
    const at = tail ? sliderExit(object) : event.holdDrop ? sliderBall(object, event.time) : object
    const screen = this.toScreen(at.x, at.y)
    this.effects.push({ x: screen.x, y: screen.y, color, judgment: event.judgment, at: nowMs, broke: !!event.holdDrop, tail })
    if (this.effects.length > 40) this.effects.shift()
    return screen
  }

  draw(env: CircleEnv, session: CircleSession, songTimeMs: number, showCursor: boolean): void {
    const ctx = env.ctx
    const { radius, preemptMs, fadeInMs } = this.map
    const r = radius * this.rect.scale

    // A dark plate behind the field keeps circles readable over the moving background.
    ctx.fillStyle = env.mono ? 'rgba(0, 0, 0, 0.6)' : 'rgba(8, 5, 22, 0.42)'
    roundRect(ctx, this.rect.x, this.rect.y, this.rect.w, this.rect.h, 18)
    ctx.fill()

    const visible: CircleObject[] = []
    session.forEachVisible(songTimeMs, (object) => visible.push(object))
    const active = session.activeSlider

    // Follow points: a faint line from each circle to the next one while it approaches.
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineWidth = Math.max(1.5, r * 0.07)
    const chain = active ? [active, ...visible] : visible
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i]
      const b = chain[i + 1]
      if (b.time - a.endTime > 2) continue
      const from = this.toScreen(sliderExit(a).x, sliderExit(a).y)
      const to = this.toScreen(b.x, b.y)
      const dist = Math.hypot(to.x - from.x, to.y - from.y)
      if (dist < r * 2.6) continue
      const appear = Math.max(0, Math.min(1, (songTimeMs - (b.time * 1000 - preemptMs)) / fadeInMs))
      const ux = (to.x - from.x) / dist
      const uy = (to.y - from.y) / dist
      ctx.strokeStyle = `rgba(255, 255, 255, ${(0.22 * appear).toFixed(3)})`
      ctx.beginPath()
      ctx.moveTo(from.x + ux * r * 1.2, from.y + uy * r * 1.2)
      ctx.lineTo(from.x + ux * (r * 1.2 + (dist - r * 2.4) * appear), from.y + uy * (r * 1.2 + (dist - r * 2.4) * appear))
      ctx.stroke()
    }
    ctx.restore()

    // The running slider sits under everything that is still coming.
    if (active) this.drawSlider(env, active, songTimeMs, 1, r)

    // Later objects underneath, the next one to hit on top.
    for (let i = visible.length - 1; i >= 0; i--) {
      const object = visible[i]
      const start = object.time * 1000 - preemptMs
      const alpha = Math.max(0, Math.min(1, (songTimeMs - start) / fadeInMs))
      if (object.kind === 'slider') this.drawSlider(env, object, songTimeMs, alpha, r)
      this.drawCircle(env, object, alpha, r, songTimeMs, session.windows.good)
    }

    if (active) this.drawBall(env, active, songTimeMs, r, session.isFollowing)
    this.drawEffects(env, r)
    this.drawMarks(env, r)
    if (showCursor) this.drawCursor(env, session, songTimeMs, r)
  }

  private drawCircle(env: CircleEnv, object: CircleObject, alpha: number, r: number, songTimeMs: number, lateLimitMs: number): void {
    const ctx = env.ctx
    const color = env.color(object.color)
    const p = this.toScreen(object.x, object.y)
    const shakeAt = this.shakes.get(object.id)
    if (shakeAt !== undefined) {
      const age = env.nowMs - shakeAt
      if (age >= SHAKE_MS) this.shakes.delete(object.id)
      else if (!env.reduced) p.x += Math.sin(age * 0.11) * r * 0.16 * (1 - age / SHAKE_MS)
    }
    const late = songTimeMs - object.time * 1000
    ctx.save()
    // It only turns to the miss colour once it can no longer be hit.
    ctx.globalAlpha = alpha * (late > 0 ? Math.max(0.45, 1 - late / (lateLimitMs * 2)) : 1)
    const sprite = this.discSprite(env, late > lateLimitMs ? env.missColor : color, r)
    ctx.drawImage(sprite, p.x - sprite.width / env.dpr / 2, p.y - sprite.height / env.dpr / 2, sprite.width / env.dpr, sprite.height / env.dpr)
    env.drawText(String(object.number), p.x, p.y + r * 0.06, r * 0.8, { fill: '#ffffff', shadow: env.mono ? '#000000' : shade(color, -0.7), burst: color }, false)
    // The closing ring: a neon loop in the circle's colour that touches its rim exactly on the beat.
    const until = object.time * 1000 - songTimeMs
    if (until > 0) {
      const t = until / this.map.preemptMs
      const ring = r * (1 + 2.6 * t)
      const tone = env.mono ? '#ffffff' : color
      if (env.quality > 0) {
        ctx.globalAlpha = alpha * 0.28
        ctx.strokeStyle = tone
        ctx.lineWidth = Math.max(5, r * 0.3)
        ctx.beginPath()
        ctx.arc(p.x, p.y, ring, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.globalAlpha = alpha
      ctx.strokeStyle = env.mono ? '#ffffff' : shade(color, 0.55)
      ctx.lineWidth = Math.max(2, r * 0.09)
      ctx.beginPath()
      ctx.arc(p.x, p.y, ring, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
  }

  private drawSlider(env: CircleEnv, object: CircleObject, songTimeMs: number, alpha: number, r: number): void {
    if (!object.path) return
    const ctx = env.ctx
    const color = env.color(object.color)
    let path = this.paths.get(object.id)
    if (!path) {
      path = new Path2D()
      object.path.forEach((point, i) => {
        const s = this.toScreen(point.x, point.y)
        if (i === 0) path!.moveTo(s.x, s.y)
        else path!.lineTo(s.x, s.y)
      })
      this.paths.set(object.id, path)
      if (this.paths.size > 64) this.paths.delete(this.paths.keys().next().value as string)
    }
    // The same ribbon as a long arrow: a light rim, dark edges and a bright middle in its colour.
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const bands: [number, string, number][] = env.mono
      ? [[2, '#d8d8d8', 0.9], [1.86, '#1a1a1a', 0.92], [1.2, '#3a3a3a', 0.92], [0.5, '#8a8a8a', 0.9]]
      : [[2, shade(color, 0.6), 0.9], [1.86, shade(color, -0.45), 0.92], [1.3, shade(color, -0.1), 0.92], [0.6, shade(color, 0.35), 0.9]]
    for (const [width, tone, opacity] of bands) {
      ctx.globalAlpha = alpha * opacity
      ctx.strokeStyle = tone
      ctx.lineWidth = r * width
      ctx.stroke(path)
    }
    // The far end: a ring, with a turn-back mark while there are passes left.
    const end = object.path[object.path.length - 1]
    const e = this.toScreen(end.x, end.y)
    ctx.globalAlpha = alpha
    ctx.strokeStyle = 'rgba(255,255,255,0.75)'
    ctx.lineWidth = Math.max(2, r * 0.08)
    ctx.beginPath()
    ctx.arc(e.x, e.y, r * 0.86, 0, Math.PI * 2)
    ctx.stroke()
    const span = (object.endTime - object.time) / object.slides
    const passes = Math.floor(Math.max(0, songTimeMs / 1000 - object.time) / span)
    if (object.slides > 1 && passes < object.slides - 1) {
      const atEnd = passes % 2 === 0
      const tip = atEnd ? end : object.path[0]
      const back = atEnd ? object.path[Math.max(0, object.path.length - 4)] : object.path[Math.min(object.path.length - 1, 3)]
      const tipS = this.toScreen(tip.x, tip.y)
      const backS = this.toScreen(back.x, back.y)
      const angle = Math.atan2(backS.y - tipS.y, backS.x - tipS.x)
      ctx.translate(tipS.x, tipS.y)
      ctx.rotate(angle)
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.moveTo(r * 0.5, 0)
      ctx.lineTo(-r * 0.2, -r * 0.42)
      ctx.lineTo(-r * 0.2, r * 0.42)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  }

  private drawBall(env: CircleEnv, object: CircleObject, songTimeMs: number, r: number, following: boolean): void {
    const ctx = env.ctx
    const color = env.color(object.color)
    const ball = sliderBall(object, songTimeMs / 1000)
    const s = this.toScreen(ball.x, ball.y)
    ctx.save()
    if (following && env.quality > 0) {
      const flicker = 0.4 + 0.15 * Math.abs(Math.sin(env.nowMs / 32))
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = flicker
      const glow = env.glow(env.mono ? '#ffffff' : color, Math.round(r * 1.6))
      ctx.drawImage(glow, s.x - r * 1.6, s.y - r * 1.6, r * 3.2, r * 3.2)
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
    }
    const sprite = this.discSprite(env, color, r * 0.78)
    ctx.drawImage(sprite, s.x - sprite.width / env.dpr / 2, s.y - sprite.height / env.dpr / 2, sprite.width / env.dpr, sprite.height / env.dpr)
    ctx.strokeStyle = following ? (env.mono ? '#ffffff' : shade(color, 0.55)) : 'rgba(255,255,255,0.25)'
    ctx.globalAlpha = following ? 0.85 : 0.4
    ctx.lineWidth = Math.max(2, r * 0.08)
    ctx.beginPath()
    ctx.arc(s.x, s.y, (following ? this.map.followRadius / this.map.radius : 1.1) * r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  private drawEffects(env: CircleEnv, r: number): void {
    const ctx = env.ctx
    const now = env.nowMs
    this.effects = this.effects.filter((fx) => now - fx.at < TEXT_FX_MS)
    for (const fx of this.effects) {
      const age = now - fx.at
      if (fx.judgment !== 'miss' && age < HIT_FX_MS && !fx.tail) {
        const t = age / HIT_FX_MS
        if (env.quality > 0) {
          // The lit-up flash the arrows get on their target.
          const size = r * (1.5 + (env.reduced ? 0 : 0.5 * t))
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.globalAlpha = (1 - t) * 0.7
          ctx.drawImage(env.glow(env.mono ? '#ffffff' : fx.color, Math.round(r * 1.5)), fx.x - size, fx.y - size, size * 2, size * 2)
          ctx.restore()
        }
        ctx.save()
        ctx.globalAlpha = (1 - t) * 0.9
        ctx.strokeStyle = env.mono ? '#ffffff' : fx.color
        ctx.lineWidth = Math.max(2, r * 0.14 * (1 - t))
        ctx.beginPath()
        ctx.arc(fx.x, fx.y, r * (1 + (env.reduced ? 0.1 : 0.45) * t), 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      }
      // Words only where they tell the player something: an off-time hit, a miss, a broken slider.
      const label = fx.broke ? 'BREAK' : fx.judgment === 'miss' ? 'MISS' : fx.judgment === 'great' ? 'GREAT' : fx.judgment === 'good' ? 'GOOD' : ''
      if (!label) continue
      const t = age / TEXT_FX_MS
      ctx.save()
      ctx.globalAlpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4
      env.drawText(label, fx.x, fx.y - r * 0.2 - (env.reduced ? 0 : age * 0.03), Math.max(13, r * 0.5), env.judgeStyle(fx.judgment), false)
      ctx.restore()
    }
  }

  private drawCursor(env: CircleEnv, session: CircleSession, songTimeMs: number, r: number): void {
    const ctx = env.ctx
    let point: CirclePoint
    if (session.isAutoPlay) point = this.toScreen(session.autoPointer(songTimeMs).x, session.autoPointer(songTimeMs).y)
    else if (this.pointer.visible) point = { x: this.pointer.x, y: this.pointer.y }
    else return
    if (!env.reduced) {
      this.trail.push(point)
      if (this.trail.length > 8) this.trail.shift()
      ctx.save()
      for (let i = 0; i < this.trail.length - 1; i++) {
        ctx.globalAlpha = ((i + 1) / this.trail.length) * 0.35
        ctx.fillStyle = env.mono ? '#ffffff' : '#ffc93d'
        ctx.beginPath()
        ctx.arc(this.trail[i].x, this.trail[i].y, Math.max(3, r * 0.14), 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }
    ctx.save()
    ctx.fillStyle = env.mono ? '#ffffff' : '#ffc93d'
    ctx.strokeStyle = 'rgba(0,0,0,0.6)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(point.x, point.y, Math.max(6, r * 0.24), 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.restore()
  }

  private drawMarks(env: CircleEnv, r: number): void {
    if (this.marks.length === 0) return
    const ctx = env.ctx
    this.marks = this.marks.filter((m) => env.nowMs - m.at < MARK_MS)
    ctx.save()
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = Math.max(1.5, r * 0.06)
    for (const m of this.marks) {
      const t = (env.nowMs - m.at) / MARK_MS
      ctx.globalAlpha = 0.45 * (1 - t)
      ctx.beginPath()
      ctx.arc(m.x, m.y, r * (0.3 + 0.25 * t), 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.restore()
  }

  /**
   * A candy-gloss disc like the arrows: bright body lit from the top, a hard white highlight on
   * the upper half, a glint on the lower edge, a light rim and a halo in its own colour.
   */
  private discSprite(env: CircleEnv, color: string, r: number): HTMLCanvasElement {
    const key = `${color}|${Math.round(r * 4)}|${env.mono ? 1 : 0}|${env.quality > 0 ? 1 : 0}`
    const cached = this.sprites.get(key)
    if (cached) return cached
    const room = Math.ceil(r * 0.45) + 3
    const size = Math.ceil((r * 2 + room * 2) * env.dpr)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const c = canvas.getContext('2d')!
    c.scale(env.dpr, env.dpr)
    const mid = size / env.dpr / 2
    const body = env.mono ? shade(color, -0.35) : color
    const disc = new Path2D()
    disc.arc(mid, mid, r * 0.94, 0, Math.PI * 2)
    const fill = c.createLinearGradient(0, mid - r, 0, mid + r)
    fill.addColorStop(0, shade(body, 0.7))
    fill.addColorStop(0.3, shade(body, 0.15))
    fill.addColorStop(0.75, body)
    fill.addColorStop(1, shade(body, -0.3))
    c.fillStyle = fill
    c.save()
    if (env.quality > 0) {
      c.shadowColor = env.mono ? 'rgba(255,255,255,0.6)' : color
      c.shadowBlur = r * 0.4 * env.dpr
    }
    c.fill(disc)
    c.restore()
    c.save()
    c.clip(disc)
    const gloss = c.createLinearGradient(0, mid - r, 0, mid + r * 0.04)
    gloss.addColorStop(0, 'rgba(255,255,255,0.85)')
    gloss.addColorStop(0.55, 'rgba(255,255,255,0.32)')
    gloss.addColorStop(1, 'rgba(255,255,255,0)')
    c.fillStyle = gloss
    c.beginPath()
    c.ellipse(mid, mid - r * 0.36, r * 0.78, r * 0.56, 0, 0, Math.PI * 2)
    c.fill()
    const glint = c.createLinearGradient(0, mid + r * 0.55, 0, mid + r)
    glint.addColorStop(0, 'rgba(255,255,255,0)')
    glint.addColorStop(1, 'rgba(255,255,255,0.4)')
    c.fillStyle = glint
    c.fillRect(mid - r, mid + r * 0.55, r * 2, r * 0.45)
    c.restore()
    c.lineWidth = Math.max(1.5, r * 0.06)
    c.strokeStyle = env.mono ? '#ffffff' : shade(body, 0.6)
    c.stroke(disc)
    this.sprites.set(key, canvas)
    return canvas
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number): void {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/** Lighten (amount > 0) or darken (amount < 0) a #rrggbb colour. */
function shade(hex: string, amount: number): string {
  const target = amount < 0 ? 0 : 255
  const t = Math.abs(amount)
  const channels = [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - t) + target * t))
  return `#${channels.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
