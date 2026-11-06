import { describe, expect, it } from 'vitest'
import { FIELD_H, FIELD_W } from '../chart/circles'
import { CircleField } from './circleField'

const map = { objects: [], radius: 36, preemptMs: 900, fadeInMs: 600, followRadius: 86 }

describe('circle field layout', () => {
  for (const [w, h, portrait] of [[1280, 720, false], [390, 844, true], [1920, 1080, false]] as const) {
    it(`maps the field to the screen and back at ${w}x${h}`, () => {
      const field = new CircleField(map)
      const rect = field.layout(w, h, 1)
      expect(rect.portrait).toBe(portrait)
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.w).toBeLessThanOrEqual(w)
      expect(rect.y + rect.h).toBeLessThanOrEqual(h)
      for (const [fx, fy] of [[0, 0], [FIELD_W, FIELD_H], [100, 300], [256, 192]]) {
        const screen = field.toScreen(fx, fy)
        expect(screen.x).toBeGreaterThanOrEqual(rect.x)
        expect(screen.x).toBeLessThanOrEqual(rect.x + rect.w)
        expect(screen.y).toBeGreaterThanOrEqual(rect.y)
        expect(screen.y).toBeLessThanOrEqual(rect.y + rect.h)
        const back = field.toField(screen.x, screen.y)
        expect(back.x).toBeCloseTo(fx, 6)
        expect(back.y).toBeCloseTo(fy, 6)
      }
    })
  }

  it('keeps circles big on a portrait phone by turning the field', () => {
    const field = new CircleField(map)
    expect(field.layout(390, 844, 3).scale).toBeGreaterThan(0.75)
  })
})
