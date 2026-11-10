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
import { BackButton, Button, Choice, KeyCap, NO_SINGING_HINT, Panel, ProgressBar, Slider, Stat, Toggle, followOptions, useConfirm, useSingingSupport } from '../components'
import { SYNC_HINT, formatBytes, formatPercent, formatSync } from '../format'
import { CalibrateDialog } from '../Calibrate'
import { buildBackup, parseBackup, restoreBackup } from '../../store/backup'

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
  { value: 'tile', label: 'Rectangle', color: '#ffc93d' },
  { value: 'square', label: 'Square', color: '#5fb2ff' },
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
      {shape === 'tile' && <rect {...common} x="7" y="1" width="10" height="22" rx="1.5" />}
      {shape === 'square' && <rect {...common} x="4" y="4" width="16" height="16" rx="2" />}
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
  const singing = useSingingSupport()
  const [touchOnly] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)
  const arrowMode = settings.playMode !== 'circles'
  const [ask, confirmDialog] = useConfirm()

  const [calibrating, setCalibrating] = useState(false)
  const backupInputRef = useRef<HTMLInputElement | null>(null)
  const saveBackupFile = async (): Promise<void> => {
    try {
      const text = await buildBackup(settings)
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `beatbreak-backup-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 10000)
      onToast('Backup saved to your downloads.', 'success')
    } catch (error) {
      onToast(`Could not save a backup: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }
  const restoreBackupFile = async (file: File): Promise<void> => {
    try {
      const { backup, skipped } = parseBackup(await file.text())
      const when = backup.savedAt ? ` from ${backup.savedAt.slice(0, 10)}` : ''
      if (!(await ask(`Restore ${backup.songs.length} song(s), their charts and ${backup.scores.length} score(s)${when}? A song that is already here is replaced by the backup's copy, and your settings are replaced.`, 'Restore'))) return
      const done = await restoreBackup(backup)
      if (backup.settings) onUpdate(backup.settings)
      onLibraryChanged()
      await refreshStorage()
      onToast(`Restored ${done.songs} song(s) and ${done.scores} score(s).${skipped > 0 ? ` ${skipped} broken entr${skipped === 1 ? 'y was' : 'ies were'} skipped.` : ''} Songs whose file is not on this device ask for it the first time you play them.`, 'success')
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'error')
    }
  }

  /** Ask first, then run a destructive storage action and report a failure instead of dropping it. */
  const guarded = async (question: string, action: () => Promise<void>): Promise<void> => {
    if (!(await ask(question))) return
    try {
      await action()
    } catch (error) {
      onToast(`That did not work: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

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
        {confirmDialog}
        <div className="grow" />
        <Button
          variant="ghost"
          onClick={() => {
            void ask('Reset every setting, including your key bindings?', 'Reset').then((ok) => ok && onReset())
          }}
        >
          Restore defaults
        </Button>
      </div>

      <Panel title="Gameplay">
        <div className="settings-stack">
          <Choice
            label="Mode"
            value={settings.playMode}
            options={[
              { value: 'arrows', label: 'Arrows' },
              { value: 'circles', label: 'Circles (Beta)' },
            ]}
            onChange={(value) => onUpdate({ playMode: value })}
          />
          <Choice
            label={arrowMode ? 'Arrows follow' : 'Circles follow'}
            value={singing === false ? 'music' : settings.follow}
            options={followOptions(singing)}
            onChange={(value) => onUpdate({ follow: value })}
            hint={singing === false ? NO_SINGING_HINT : undefined}
          />
          {!arrowMode && (
            <Toggle
              label="Path to the next circle"
              checked={settings.circlePath}
              onChange={(value) => onUpdate({ circlePath: value })}
            />
          )}
          <Choice
            label="Default difficulty"
            value={settings.defaultDifficulty}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'easy', label: 'Easy', color: DIFFICULTY_COLOR.easy },
              { value: 'normal', label: 'Normal', color: DIFFICULTY_COLOR.normal },
              { value: 'hard', label: 'Hard', color: DIFFICULTY_COLOR.hard },
              { value: 'expert', label: 'Expert', color: DIFFICULTY_COLOR.expert },
            ]}
            onChange={(value) => onUpdate({ defaultDifficulty: value })}
          />
          {arrowMode && (
          <>
          <Choice
            label="Timing"
            value={settings.timing}
            options={[
              { value: 'pc', label: 'PC' },
              { value: 'phone', label: 'Phone' },
            ]}
            onChange={(value) => onUpdate({ timing: value })}
          />
          <Choice
            label="Long arrows"
            value={settings.longArrows ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(value) => onUpdate({ longArrows: value === 'on' })}
          />
          {settings.longArrows && (
          <Choice
            label="Ending a long arrow"
            value={settings.holdMode}
            options={[
              { value: 'hold', label: 'Hold' },
              { value: 'release', label: 'Let go' },
            ]}
            onChange={(value) => onUpdate({ holdMode: value })}
            hint="Hold: keep holding to the end. Let go: release on the end arrow. Letting go early always misses."
          />
          )}
          <Choice
            label="Direction"
            value={settings.scrollDirection}
            options={[
              { value: 'up', label: 'Up' },
              { value: 'down', label: 'Down' },
            ]}
            onChange={(value) => onUpdate({ scrollDirection: value })}
          />
          </>
          )}
          <Slider
            label={arrowMode ? 'Scroll speed' : 'Approach speed'}
            value={settings.scrollSpeed}
            min={1}
            max={10}
            step={0.1}
            onChange={(value) => onUpdate({ scrollSpeed: value })}
            format={(value) => `${value.toFixed(1)} / 10`}
          />
        </div>
      </Panel>

      <Panel title="Style">
        <div className="settings-stack">
          {arrowMode && (
          <>
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
          />
          </>
          )}
          <Choice
            label="Theme"
            value={settings.theme === 'mono' ? 'mono' : 'disco'}
            options={[
              { value: 'disco', label: 'Arcade' },
              { value: 'mono', label: 'Blackout' },
            ]}
            onChange={(value) => onUpdate({ theme: value })}
          />
          <Choice
            label="Arrow colours"
            value={settings.arrowColors}
            options={[
              { value: 'column', label: 'Per column' },
              { value: 'random', label: 'Shuffle' },
            ]}
            onChange={(value) => onUpdate({ arrowColors: value })}
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
              { value: 'top', label: 'Top line' },
              { value: 'column', label: 'Under title' },
              { value: 'text', label: 'Percent' },
            ]}
            onChange={(value) => onUpdate({ progressStyle: value })}
          />
          <Toggle
            label="Reduced motion"
            checked={settings.reducedMotion}
            onChange={(value) => onUpdate({ reducedMotion: value })}
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
          />
          <Slider
            label="Audio sync"
            value={settings.audioOffsetMs}
            min={-250}
            max={250}
            step={5}
            onChange={(value) => onUpdate({ audioOffsetMs: value })}
            format={formatSync}
            hint={SYNC_HINT}
          />
          <div>
            <Button size="sm" onClick={() => setCalibrating(true)}>
              Calibrate
            </Button>
            <p className="muted tiny mt-8">Tap along with a click to set Audio sync for your speakers or headphones.</p>
          </div>
          {calibrating && <CalibrateDialog onApply={(value) => onUpdate({ audioOffsetMs: value })} onClose={() => setCalibrating(false)} />}
          <Toggle
            label="Menu music"
            checked={settings.menuMusic}
            onChange={(value) => onUpdate({ menuMusic: value })}
          />
          <Toggle
            label="Click sounds"
            checked={settings.uiSounds}
            onChange={(value) => onUpdate({ uiSounds: value })}
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
              { value: 'window', label: 'Window' },
              { value: 'fullscreen', label: 'Fullscreen' },
            ]}
            onChange={(value) => onUpdate({ displayMode: value })}
          />
          <Toggle
            label="Show diagnostics"
            checked={settings.showStats}
            onChange={(value) => onUpdate({ showStats: value })}
          />
        </div>
      </details>

      <div className="settings-stack mt-16">
        <div className="row-between wrap gap-12">
          <div>
            <strong>Backup</strong>
            <p className="muted tiny">Songs, charts, scores and settings in one file. Browsers can clear saved data, so keep one. Song files are not included.</p>
          </div>
          <div className="row gap-8 wrap">
            <Button size="sm" onClick={() => void saveBackupFile()}>
              Save a backup
            </Button>
            <Button size="sm" onClick={() => backupInputRef.current?.click()}>
              Restore
            </Button>
            <input
              ref={backupInputRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void restoreBackupFile(file)
              }}
            />
          </div>
        </div>
      </div>

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
            onClick={() =>
              void guarded('Delete every score and personal best? This cannot be undone.', async () => {
                await clearScores()
                await refreshStorage()
                onToast('Score history cleared.', 'success')
              })
            }
          >
            Clear scores
          </Button>
          <Button
            size="sm"
            onClick={() =>
              void guarded('Delete the saved song files? Charts and scores stay, but you will pick each file again to play it.', async () => {
                await idbAudioClearAndFlag()
                onLibraryChanged()
                await refreshStorage()
                onToast('Saved audio deleted. Charts and scores were kept.', 'success')
              })
            }
          >
            Forget saved audio
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() =>
              void guarded('Delete every song, chart, score and setting? This cannot be undone.', async () => {
                await wipeEverything()
                await refreshStorage()
                onLibraryChanged()
                onReset()
                onToast('All Beatbreak data deleted.', 'success')
              })
            }
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
