import { describe, expect, it } from 'vitest'
import { DEFAULT_KEYMAP, InputRouter, attachTouchLanes, rebindLaneKey } from './input'

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

describe('InputRouter edge cases', () => {
  const setup = () => {
    const win = new EventTarget()
    const doc = new EventTarget()
    Object.assign(globalThis, { window: win, document: doc })
    const log: string[] = []
    const router = new InputRouter(win as unknown as Window, {
      onLaneDown: (lane) => log.push(`down ${lane}`),
      onLaneUp: (lane) => log.push(`up ${lane}`),
      onRestart: () => log.push('restart'),
      onLaneStillHeld: (lane) => log.push(`still ${lane}`),
    }, { keyMap: { left: ['KeyA', 'ArrowLeft'], down: ['KeyS'], up: ['KeyW'], right: ['KeyD'] } })
    const key = (type: 'keydown' | 'keyup', code: string, extra: Record<string, unknown> = {}) => {
      const event = Object.assign(new Event(type), { code, key: code, repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...extra })
      win.dispatchEvent(event)
    }
    return { win, log, router, key }
  }

  it('leaves Ctrl, Cmd and Alt shortcuts to the browser', () => {
    const { log, key, router } = setup()
    key('keydown', 'KeyR', { ctrlKey: true })
    key('keydown', 'KeyA', { metaKey: true })
    expect(log).toEqual([])
    key('keydown', 'KeyR')
    expect(log).toEqual(['restart'])
    router.dispose()
  })

  it('treats a repeat of a key still down after a blur as held, not as a new press', () => {
    const { win, log, key, router } = setup()
    key('keydown', 'KeyA')
    win.dispatchEvent(new Event('blur'))
    key('keydown', 'KeyA', { repeat: true })
    key('keydown', 'KeyA', { repeat: true })
    expect(log).toEqual(['down 0', 'up 0', 'still 0'])
    router.dispose()
  })

  it('keeps a lane held until the last of its keys comes up', () => {
    const { log, key, router } = setup()
    key('keydown', 'KeyA')
    key('keydown', 'ArrowLeft')
    key('keyup', 'KeyA')
    expect(log).toEqual(['down 0', 'down 0'])
    key('keyup', 'ArrowLeft')
    expect(log).toEqual(['down 0', 'down 0', 'up 0'])
    router.dispose()
  })
})

describe('attachTouchLanes', () => {
  const pointer = (type: string, pointerId: number, clientX: number, button = 0) =>
    Object.assign(new Event(type), { pointerId, clientX, button })

  it('ignores the right mouse button and keeps a column held until its last finger lifts', () => {
    const element = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, width: 400 }) })
    const log: string[] = []
    const detach = attachTouchLanes(element as unknown as HTMLElement, {
      onLaneDown: (lane) => log.push(`down ${lane}`),
      onLaneUp: (lane) => log.push(`up ${lane}`),
    })
    element.dispatchEvent(pointer('pointerdown', 1, 50, 2))
    expect(log).toEqual([])
    element.dispatchEvent(pointer('pointerdown', 1, 50))
    element.dispatchEvent(pointer('pointerdown', 2, 60))
    element.dispatchEvent(pointer('pointerup', 1, 50))
    expect(log).toEqual(['down 0', 'down 0'])
    element.dispatchEvent(pointer('pointerup', 2, 60))
    expect(log).toEqual(['down 0', 'down 0', 'up 0'])
    detach()
  })
})
