/**
 * Settings, ordered by what a player touches: sound, how the playfield looks, then controls.
 * Timing, failure and autoplay are fixed defaults now: there is one fair ruleset and no reason to
 * make a new player configure it. Storage lives behind a disclosure so the page stays calm.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { LANE_INFO, type Lane } from '../../core/types'
import { CONTROL_DEFAULTS, DEFAULT_KEYMAP, describeKey, rebindLaneKey } from '../../game/input'
import type { KeyMap } from '../../game/input'
import type { NoteShape } from '../../render/renderer'
import type { Settings } from '../../store/settings'
import { storageSummary, clearScores, idbAudioClearAndFlag, wipeEverything } from '../../store/maintenance'
import type { StorageSummary } from '../../store/maintenance'
import { Button, KeyCap, Panel, ProgressBar, Select, Slider, Stat, Toggle } from '../components'
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
  { value: 'arrow', label: 'Arrow', color: '#56b4e9' },
  { value: 'chevron', label: 'Chevron', color: '#e69f00' },
  { value: 'diamond', label: 'Diamond', color: '#009e73' },
  { value: 'orb', label: 'Orb', color: '#f0e442' },
  { value: 'star', label: 'Star', color: '#d55e00' },
  { value: 'hex', label: 'Hex', color: '#a9b6c2' },
  { value: 'bar', label: 'Bar', color: '#f2f5f7' },
]

const NOTE_SKIN_LABEL: Record<NoteShape, string> = {
  arrow: 'Arrow',
  chevron: 'Chevron',
  diamond: 'Diamond',
  orb: 'Orb',
  star: 'Star',
  hex: 'Hex',
  bar: 'Bar',
}

function NoteShapeIcon({ shape }: { shape: NoteShape }): React.JSX.Element {
  if (shape === 'arrow') {
    return (
      <span className="note-skin-glyph" aria-hidden="true">
        →
      </span>
    )
  }
  const common = { fill: 'currentColor', stroke: 'none' } as const
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      {shape === 'chevron' && <polygon {...common} points="3,5 21,12 3,19 9,12" />}
      {shape === 'diamond' && <polygon {...common} points="12,3 21,12 12,21 3,12" />}
      {shape === 'orb' && <circle {...common} cx="12" cy="12" r="9" />}
      {shape === 'star' && (
        <polygon {...common} points="12,2 14.9,9 22,9.6 16.5,14.4 18.3,21.5 12,17.6 5.7,21.5 7.5,14.4 2,9.6 9.1,9" />
      )}
      {shape === 'hex' && <polygon {...common} points="7,3 17,3 22,12 17,21 7,21 2,12" />}
      {shape === 'bar' && <rect {...common} x="2" y="7" width="20" height="10" rx="4" />}
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
      <div className="row-between wrap gap-12">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            if (window.confirm('Reset every setting, including your key bindings?')) onReset()
          }}
        >
          Restore defaults
        </Button>
      </div>
      <h1>Settings</h1>

      <Panel title="Audio">
        <div className="settings-grid">
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
          <Toggle
            label="Menu music"
            checked={settings.menuMusic}
            onChange={(value) => onUpdate({ menuMusic: value })}
            hint="Plays a loop of your latest song behind the menus."
          />
        </div>
      </Panel>

      <Panel title="Playfield">
        <div className="settings-grid">
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
          <Select
            label="Direction"
            value={settings.scrollDirection}
            options={[
              { value: 'up', label: 'Rise — targets at the top (arcade)' },
              { value: 'down', label: 'Fall — targets at the bottom (classic)' },
            ]}
            onChange={(value) => onUpdate({ scrollDirection: value })}
          />
          <Slider
            label="Arrow size"
            value={settings.noteScale}
            min={0.8}
            max={1.7}
            step={0.05}
            onChange={(value) => onUpdate({ noteScale: value })}
            format={(value) => `${Math.round(value * 100)}%`}
            hint="Tap notes, hold tails and target outlines scale together."
          />
          <Toggle
            label="Reduced motion"
            checked={settings.reducedMotion}
            onChange={(value) => onUpdate({ reducedMotion: value })}
            hint="Turns off particles and motion effects."
          />
        </div>

        <details className="disclosure mt-24">
          <summary>
            <span>Arrow style</span>
            <span className="disclosure-value">{NOTE_SKIN_LABEL[settings.noteShape]}</span>
          </summary>
          <div className="note-skin-grid mt-12" role="radiogroup" aria-label="Arrow style">
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
        </details>
      </Panel>

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

      <details className="disclosure">
        <summary>
          <span>Advanced</span>
        </summary>
        <div className="grid cols-2 mt-12">
          <Select
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
