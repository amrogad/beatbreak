/**
 * Tiny pooled particle system for hit feedback.
 *
 * Fixed-size pool, no allocation during play, and a hard budget per burst so a chord cannot
 * double the frame cost. With reduced motion enabled the renderer simply never spawns these.
 */

interface Particle {
  active: boolean
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
  color: string
  /** 0 = spark (fades fast), 1 = ember (drifts). */
  kind: 0 | 1
}

export class ParticleSystem {
  private particles: Particle[]
  private cursor = 0

  constructor(capacity = 320) {
    this.particles = new Array<Particle>(capacity)
    for (let i = 0; i < capacity; i++) {
      this.particles[i] = {
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 1,
        size: 2,
        color: '#fff',
        kind: 0,
      }
    }
  }

  get activeCount(): number {
    let active = 0
    for (const p of this.particles) if (p.active) active++
    return active
  }

  /** Rect burst used for hits (sparks fly up) and misses (embers fall). */
  burst(x: number, y: number, color: string, options: { count?: number; strength?: number; spread?: number; downward?: boolean } = {}): void {
    const count = Math.max(1, Math.min(options.count ?? 14, 48))
    const strength = options.strength ?? 1
    const spread = options.spread ?? 1
    for (let i = 0; i < count; i++) {
      const p = this.particles[this.cursor]
      this.cursor = (this.cursor + 1) % this.particles.length
      const angle = options.downward
        ? Math.PI / 2 + (Math.random() - 0.5) * 1.4
        : -Math.PI / 2 + (Math.random() - 0.5) * (1.9 * spread)
      const speed = (60 + Math.random() * 240) * strength
      p.active = true
      p.x = x + (Math.random() - 0.5) * 14
      p.y = y + (Math.random() - 0.5) * 8
      p.vx = Math.cos(angle) * speed
      p.vy = Math.sin(angle) * speed
      p.maxLife = 0.28 + Math.random() * 0.42
      p.life = p.maxLife
      p.size = 1.4 + Math.random() * 3.4
      p.color = color
      p.kind = options.downward ? 1 : 0
    }
  }

  clear(): void {
    for (const p of this.particles) p.active = false
  }

  /** Advance by a wall-clock delta in milliseconds (decoration only — never a gameplay clock). */
  update(dtMs: number): void {
    const dt = Math.min(dtMs, 64) / 1000
    for (const p of this.particles) {
      if (!p.active) continue
      p.life -= dt
      if (p.life <= 0) {
        p.active = false
        continue
      }
      const drag = p.kind === 1 ? 0.9 : 1.9
      p.vx -= p.vx * drag * dt
      p.vy -= p.vy * drag * dt
      p.vy += (p.kind === 1 ? 420 : 260) * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.save()
    // Flat compositing: hit sparks are small solid flecks, not additive glow.
    ctx.globalCompositeOperation = 'source-over'
    for (const p of this.particles) {
      if (!p.active) continue
      const t = Math.max(0, Math.min(1, p.life / p.maxLife))
      ctx.globalAlpha = t * (p.kind === 1 ? 0.7 : 0.9)
      ctx.fillStyle = p.color
      const size = p.size * (0.4 + t * 0.6)
      ctx.fillRect(p.x - size, p.y - size, size * 2, size * 2)
    }
    ctx.restore()
  }
}
