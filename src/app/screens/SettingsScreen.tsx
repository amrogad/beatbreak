/**
 * Settings, ordered by what a player changes most: how the game plays, how it looks, sound, then
 * keys. One control per row and short option lists as big buttons, so a kid can follow it.
 * Timing, failure and autoplay are fixed defaults now: there is one fair ruleset and no reason to
 * make a new player configure it. Storage lives behind a disclosure so the page stays calm.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { DIFFICULTY_COLOR, LANE_INFO, type Lane } from '../../core/types'
import { CONTROL_DEFAULTS, DEFAULT_KEYMAP, describeKey, rebindLaneKey } from '../../game/input'
import type { KeyMap } from '../../game/input'
import type { NoteShape } from '../../render/renderer'
import type { Settings } from '../../store/settings'
import { storageSummary, clearScores, idbAudioClearAndFlag, wipeEverything } from '../../store/maintenance'
import type { StorageSummary } from '../../store/maintenance'
import { BackButton, Button, Choice, KeyCap, Panel, ProgressBar, Slider, Stat, Toggle } from '../components'
import { formatBytes, formatPercent } from '../format'

export interface SettingsScreenProps {
  settings: Settings
  onUpdate: (patch: Partial<Settings>) => void
  onReset: () => void
  onBack: () => void
  onToast: (message: string, tone?: 'info' | 'error' | 'success') => void
  onLibraryChanged: () => void
}

const NOTE_SKINS: { value: NoteShape; label: string; color: string }[] = [
  { value: 'arrow', label: 'Arrow', color: '#3d9bff' },
  { value: 'chevron', label: 'Chevron', color: '#ff7a3d' },
  { value: 'diamond', label: 'Diamond', color: '#3fe08a' },
  { value: 'orb', label: 'Orb', color: '#f0e442' },
  { value: 'star', label: 'Star', color: '#ff4f9a' },
  { value: 'hex', label: 'Hex', color: '#a9b6c2' },
  { value: 'bar', label: 'Bar', color: '#f2f5f7' },
  { value: 'tile', label: 'Piano tile', color: '#ffc93d' },
]

function NoteShapeIcon({ shape }: { shape: NoteShape }): React.JSX.Element {
  const common = { fill: 'currentColor', stroke: 'none' } as const
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      {shape === 'arrow' && <polygon {...common} points="2,9 12,9 12,3 22,12 12,21 12,15 2,15" />}
      {shape === 'chevron' && <polygon {...common} points="3,5 21,12 3,19 9,12" />}
      {shape === 'diamond' && <polygon {...common} points="12,3 21,12 12,21 3,12" />}
      {shape === 'orb' && <circle {...common} cx="12" cy="12" r="9" />}
      {shape === 'star' && (
        <polygon {...common} points="12,2 14.9,9 22,9.6 16.5,14.4 18.3,21.5 12,17.6 5.7,21.5 7.5,14.4 2,9.6 9.1,9" />
      )}
      {shape === 'hex' && <polygon {...common} points="7,3 17,3 22,12 17,21 7,21 2,12" />}
      {shape === 'bar' && <rect {...common} x="2" y="7" width="20" height="10" rx="4" />}
      {shape === 'tile' && <rect {...common} x="2" y="6" width="20" height="12" rx="2" />}
    </svg>
  )
}

export function SettingsScreen({
  settings,
  onUpdate,
  onReset,
  onBack,
  onToast,
  onLibraryChanged,
}: SettingsScreenProps): React.JSX.Element {
  const [summary, setSummary] = useState<StorageSummary | null>(null)
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(null)
  const [capturingLane, setCapturingLane] = useState<Lane | null>(null)
  const captureRef = useRef<Lane | null>(null)
  // Phones and tablets have no keys to set, so the key panel only shows where there is a keyboard.
  const [touchOnly] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)

  const refreshStorage = useCallback(async () => {
    try {
      setSummary(await storageSummary())
    } catch {
      setSummary(null)
    }
    try {
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate()
        setQuota({ usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 })
      }
    } catch {
      setQuota(null)
    }
  }, [])

  useEffect(() => {
    void refreshStorage()
  }, [refreshStorage])

  /* ------------------------------------------------------------------- keys */

  useEffect(() => {
    captureRef.current = capturingLane
  }, [capturingLane])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const lane = captureRef.current
      if (lane === null) return
      event.preventDefault()
      event.stopPropagation()
      const code = event.code || event.key
      setCapturingLane(null)
      if (code === 'Escape') return
      // Move the key, don't clone it. If it was another lane's only key, that lane gets the key
      // you replaced, so a W/A swap stays a swap instead of resetting the map.
      onUpdate({ keyMap: rebindLaneKey(settings.keyMap, lane, code) })
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onUpdate, settings.keyMap])

  return (
    <div className="page narrow">
      <div className="title-row">
        <BackButton onClick={onBack} />
        <h1>Settings</h1>
        <div className="grow" />
        <Button
          variant="ghost"
          onClick={() => {
            if (window.confirm('Reset every setting, including your key bindings?')) onReset()
          }}
        >
          Restore defaults
        </Button>
      </div>

      <Panel title="Gameplay">
        <div className="settings-stack">
          <Choice
            label="Default difficulty"
            value={settings.defaultDifficulty}
            options={[
              { value: 'auto', label: 'Recommended for each song' },
              { value: 'easy', label: 'Easy', color: DIFFICULTY_COLOR.easy },
              { value: 'normal', label: 'Normal', color: DIFFICULTY_COLOR.normal },
              { value: 'hard', label: 'Hard', color: DIFFICULTY_COLOR.hard },
              { value: 'expert', label: 'Expert', color: DIFFICULTY_COLOR.expert },
            ]}
            onChange={(value) => onUpdate({ defaultDifficulty: value })}
            hint="Used until you pick a difficulty for a song; that song then remembers your pick."
          />
          <Choice
            label="Timing"
            value={settings.timing}
            options={[
              { value: 'pc', label: 'PC, tight windows for keys' },
              { value: 'phone', label: 'Phone, wider windows for tapping' },
            ]}
            onChange={(value) => onUpdate({ timing: value })}
            hint="Phones start on phone timing."
          />
          <Choice
            label="Long arrows"
            value={settings.holdMode}
            options={[
              { value: 'hold', label: 'Just hold to the end' },
              { value: 'release', label: 'Let go on the end arrow' },
            ]}
            onChange={(value) => onUpdate({ holdMode: value })}
            hint="Either way, letting go early misses the hold."
          />
          <Choice
            label="Direction"
            value={settings.scrollDirection}
            options={[
              { value: 'up', label: 'Rise — targets at the top (arcade)' },
              { value: 'down', label: 'Fall — targets at the bottom (classic)' },
            ]}
            onChange={(value) => onUpdate({ scrollDirection: value })}
          />
          <Slider
            label="Scroll speed"
            value={settings.scrollSpeed}
            min={1}
            max={10}
            step={0.1}
            onChange={(value) => onUpdate({ scrollSpeed: value })}
            format={(value) => `${value.toFixed(1)} / 10`}
            hint="Higher = arrows travel faster, so you read less of the chart ahead."
          />
        </div>
      </Panel>

      <Panel title="Style">
        <div className="settings-stack">
          <div className="field">
            <span className="field-label">Arrow style</span>
            <div className="note-skin-grid" role="radiogroup" aria-label="Arrow style">
              {NOTE_SKINS.map((skin) => (
                <button
                  key={skin.value}
                  type="button"
                  role="radio"
                  aria-checked={settings.noteShape === skin.value}
                  className={`note-skin${settings.noteShape === skin.value ? ' is-selected' : ''}`}
                  style={{ '--skin': skin.color } as React.CSSProperties}
                  onClick={() => onUpdate({ noteShape: skin.value })}
                >
                  <NoteShapeIcon shape={skin.value} />
                  <span>{skin.label}</span>
                </button>
              ))}
            </div>
          </div>
          <Slider
            label="Arrow size"
            value={settings.noteScale}
            min={0.6}
            max={1.3}
            step={0.05}
            onChange={(value) => onUpdate({ noteScale: value })}
            format={(value) => `${Math.round(value * 100)}%`}
            hint="Tap notes, hold tails and target outlines scale together."
          />
          <Choice
            label="Theme"
            value={settings.theme === 'mono' ? 'mono' : 'disco'}
            options={[
              { value: 'disco', label: 'Arcade, in colour' },
              { value: 'mono', label: 'Blackout, white light only' },
            ]}
            onChange={(value) => onUpdate({ theme: value })}
          />
          <Choice
            label="Arrow colours"
            value={settings.arrowColors}
            options={[
              { value: 'column', label: 'One colour per column' },
              { value: 'random', label: 'Shuffle colours every song' },
            ]}
            onChange={(value) => onUpdate({ arrowColors: value })}
            hint="The Blackout theme keeps every arrow white."
          />
          {settings.arrowColors === 'column' && (
            <div className="field">
              <span className="field-label">Column colours</span>
              <div className="color-row">
                {['Left', 'Down', 'Up', 'Right'].map((label, index) => (
                  <label key={label} className="color-pick">
                    <input
                      type="color"
                      value={settings.columnColors[index]}
                      onChange={(event) => {
                        const next = [...settings.columnColors]
                        next[index] = event.target.value
                        onUpdate({ columnColors: next })
                      }}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <Choice
            label="Song progress"
            value={settings.progressStyle}
            options={[
              { value: 'top', label: 'Line across the top' },
              { value: 'column', label: 'Bar under the song title' },
              { value: 'text', label: 'Percentage under accuracy' },
            ]}
            onChange={(value) => onUpdate({ progressStyle: value })}
          />
          <Toggle
            label="Reduced motion"
            checked={settings.reducedMotion}
            onChange={(value) => onUpdate({ reducedMotion: value })}
            hint="Turns off particles and motion effects."
          />
        </div>
      </Panel>

      <Panel title="Audio">
        <div className="settings-stack">
          <Slider
            label="Volume"
            value={settings.volume}
            min={0}
            max={1}
            step={0.01}
            onChange={(value) => onUpdate({ volume: value })}
            format={(value) => `${Math.round(value * 100)}%`}
            hint="Defaults to 100%. Your system volume still applies."
          />
          <Slider
            label="Arrow timing"
            value={settings.audioOffsetMs}
            min={-150}
            max={150}
            step={5}
            onChange={(value) => onUpdate({ audioOffsetMs: value })}
            format={(value) => (value === 0 ? '0 ms' : `${Math.abs(value)} ms ${value < 0 ? 'earlier' : 'later'}`)}
            hint="Hear the beat before the arrows reach the targets? Move it earlier. The results screen suggests a value after each song."
          />
          <Toggle
            label="Menu music"
            checked={settings.menuMusic}
            onChange={(value) => onUpdate({ menuMusic: value })}
            hint="Plays a loop of your latest song behind the menus."
          />
        </div>
      </Panel>

      {!touchOnly && (
      <Panel title="Controls">
        <div className="settings-group">
          <div className="settings-group-head">
            <span className="field-label">Arrow keys</span>
            <Button size="sm" onClick={() => onUpdate({ keyMap: DEFAULT_KEYMAP })}>
              Reset arrow keys
            </Button>
          </div>
          <div className="col gap-12">
            {LANE_INFO.map((info) => {
              const laneKey = (['left', 'down', 'up', 'right'] as (keyof KeyMap)[])[info.lane]
              const keys = settings.keyMap[laneKey]
              return (
                <div className="settings-key-row" key={info.id}>
                  <span className="settings-key-label" style={{ color: info.color }}>
                    {info.arrow} {info.label}
                  </span>
                  <div className="row gap-8 wrap">
                    {keys.map((code) => (
                      <KeyCap
                        key={code}
                        label={code}
                        onCapture={(captured) => {
                          onUpdate({ keyMap: rebindLaneKey(settings.keyMap, info.lane, captured, code) })
                        }}
                        onClear={() => {
                          if (keys.length <= 1) {
                            onToast('Each arrow needs at least one key. Add another key before removing this one.', 'info')
                            return
                          }
                          const map: KeyMap = { ...settings.keyMap, [laneKey]: keys.filter((existing) => existing !== code) }
                          onUpdate({ keyMap: map })
                        }}
                      />
                    ))}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setCapturingLane(info.lane)}
                      title="Add another key for this lane"
                    >
                      {capturingLane === info.lane ? 'Press a key…' : '+ Key'}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="hr" />

        <div className="settings-group">
          <div className="settings-group-head">
            <span className="field-label">Other keys</span>
            <Button size="sm" onClick={() => onUpdate({ controls: CONTROL_DEFAULTS })}>
              Reset other keys
            </Button>
          </div>
          <div className="settings-key-list">
            {(
              [
                ['Pause', settings.controls.pause],
                ['Restart', settings.controls.restart],
                ['Fullscreen', settings.controls.fullscreen],
              ] as const
            ).map(([label, codes]) => (
              <div className="settings-key-row" key={label}>
                <span className="settings-key-label">{label}</span>
                <div className="row gap-8">
                  {codes.map((code) => (
                    <span className="keycap" key={code}>
                      {describeKey(code)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Panel>
      )}

      <details className="disclosure">
        <summary>
          <span>Advanced</span>
        </summary>
        <div className="settings-stack mt-12">
          <Choice
            label="Display mode"
            value={settings.displayMode}
            options={[
              { value: 'window', label: 'Windowed' },
              { value: 'fullscreen', label: 'Fullscreen while playing' },
            ]}
            onChange={(value) => onUpdate({ displayMode: value })}
            hint="The browser can refuse fullscreen."
          />
          <Toggle
            label="Show diagnostics"
            checked={settings.showStats}
            onChange={(value) => onUpdate({ showStats: value })}
            hint="Frame rate and quality level in the corner."
          />
        </div>
      </details>

      <details className="disclosure">
        <summary>
          <span>Storage</span>
        </summary>
        <div className="grid cols-3 mt-12">
          <Stat label="Songs" value={summary?.songs ?? '—'} />
          <Stat label="Charts" value={summary?.charts ?? '—'} />
          <Stat label="Runs" value={summary?.runs ?? '—'} />
          <Stat label="Saved audio" value={summary?.cachedAudio ?? '—'} />
          {quota && quota.quota > 0 && (
            <Stat
              label="Space used"
              value={formatBytes(quota.usage)}
              hint={`${formatPercent(quota.usage / quota.quota, 1)} of ${formatBytes(quota.quota)}`}
            />
          )}
        </div>
        {quota && quota.quota > 0 && (
          <div className="mt-12">
            <ProgressBar fraction={quota.usage / quota.quota} />
          </div>
        )}
        <div className="row gap-8 wrap mt-16">
          <Button
            size="sm"
            onClick={async () => {
              await clearScores()
              await refreshStorage()
              onToast('Score history cleared.', 'success')
            }}
          >
            Clear scores
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              await idbAudioClearAndFlag()
              onLibraryChanged()
              await refreshStorage()
              onToast('Saved audio deleted. Charts and scores were kept.', 'success')
            }}
          >
            Forget saved audio
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              await wipeEverything()
              await refreshStorage()
              onLibraryChanged()
              onReset()
              onToast('All PULSEGRID data deleted.', 'success')
            }}
          >
            Delete everything
          </Button>
          <Button size="sm" onClick={() => void refreshStorage()}>
            Refresh figures
          </Button>
        </div>
      </details>
    </div>
  )
}
