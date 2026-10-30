import { describe, expect, it } from 'vitest'
import { DEFAULT_KEYMAP, rebindLaneKey } from './input'

describe('rebindLaneKey', () => {
  it('swaps keys when the new key was another lane\'s only key', () => {
    // W (up) moved onto left: left gives A back to up instead of leaving up empty.
    const single = { left: ['KeyA'], down: ['KeyS'], up: ['KeyW'], right: ['KeyD'] }
    const map = rebindLaneKey(single, 0, 'KeyW', 'KeyA')
    expect(map.left).toEqual(['KeyW'])
    expect(map.up).toEqual(['KeyA'])
    expect(map.down).toEqual(['KeyS'])
    expect(map.right).toEqual(['KeyD'])
  })

  it('moves a key from a lane that has another key, without deleting it', () => {
    const map = rebindLaneKey(
      { left: ['KeyA'], down: ['KeyS'], up: ['KeyW', 'ArrowUp'], right: ['KeyD'] },
      0,
      'KeyW',
    )
    expect(map.left).toEqual(['KeyA', 'KeyW'])
    expect(map.up).toEqual(['ArrowUp'])
  })

  it('adds an extra key to a lane without touching the other lanes', () => {
    const map = rebindLaneKey(DEFAULT_KEYMAP, 0, 'KeyJ')
    expect(map.left).toEqual(['KeyA', 'ArrowLeft', 'KeyJ'])
    expect(map.down).toEqual(DEFAULT_KEYMAP.down)
    expect(map.up).toEqual(DEFAULT_KEYMAP.up)
    expect(map.right).toEqual(DEFAULT_KEYMAP.right)
  })

  it('replaces the clicked key instead of adding a second binding', () => {
    const map = rebindLaneKey(DEFAULT_KEYMAP, 0, 'KeyJ', 'KeyA')
    expect(map.left).toEqual(['ArrowLeft', 'KeyJ'])
    expect(map.down).toEqual(DEFAULT_KEYMAP.down)
    expect(map.up).toEqual(DEFAULT_KEYMAP.up)
    expect(map.right).toEqual(DEFAULT_KEYMAP.right)
  })

  it('does not duplicate a key already bound to the target lane', () => {
    const map = rebindLaneKey(DEFAULT_KEYMAP, 0, 'KeyA')
    expect(map.left.filter((code) => code === 'KeyA')).toHaveLength(1)
    expect(map.left).toContain('ArrowLeft')
  })
})
