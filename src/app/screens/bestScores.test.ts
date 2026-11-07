import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../store/settings'
import { runRulesKey, sameRules } from './bestScores'

describe('runRulesKey', () => {
  const base = DEFAULT_SETTINGS

  it('changes with every setting that makes scoring easier or harder', () => {
    const key = runRulesKey(base, 'arrows')
    expect(runRulesKey({ ...base, windowPreset: 'lenient' }, 'arrows')).not.toBe(key)
    expect(runRulesKey({ ...base, timing: 'phone' }, 'arrows')).not.toBe(key)
    expect(runRulesKey({ ...base, longArrows: false }, 'arrows')).not.toBe(key)
    expect(runRulesKey({ ...base, holdMode: 'release' }, 'arrows')).not.toBe(key)
    expect(runRulesKey({ ...base, noteShape: 'tile' }, 'arrows')).not.toBe(key)
  })

  it('ignores settings that do not touch scoring', () => {
    const key = runRulesKey(base, 'arrows')
    expect(runRulesKey({ ...base, scrollSpeed: base.scrollSpeed + 1, theme: 'mono' } as typeof base, 'arrows')).toBe(key)
    // Hold mode means nothing once long arrows are off.
    expect(runRulesKey({ ...base, longArrows: false, holdMode: 'release' }, 'arrows')).toBe(runRulesKey({ ...base, longArrows: false, holdMode: 'hold' }, 'arrows'))
  })

  it('tells custom windows apart by their values', () => {
    const custom = { ...base, windowPreset: 'custom' as const }
    const wider = { ...custom, customWindows: { ...base.customWindows, good: base.customWindows.good + 40 } }
    expect(runRulesKey(wider, 'arrows')).not.toBe(runRulesKey(custom, 'arrows'))
  })

  it('keeps circles apart from arrows and ignores arrow-only settings there', () => {
    expect(runRulesKey(base, 'circles')).not.toBe(runRulesKey(base, 'arrows'))
    expect(runRulesKey({ ...base, longArrows: false, noteShape: 'tile', timing: 'phone' }, 'circles')).toBe(runRulesKey(base, 'circles'))
  })
})

describe('sameRules', () => {
  it('counts an old unstamped run under any rules', () => {
    expect(sameRules({}, 'standard | pc | long hold | arrow')).toBe(true)
    expect(sameRules({ rules: 'lenient | pc | long hold | arrow' }, 'standard | pc | long hold | arrow')).toBe(false)
    expect(sameRules({ rules: 'standard | pc | long hold | arrow' }, 'standard | pc | long hold | arrow')).toBe(true)
  })
})
