/** Small shared UI building blocks. Everything here is presentational and dependency-free. */
import React, { useEffect, useState } from 'react'
import type { Difficulty } from '../core/types'
import { DIFFICULTIES, DIFFICULTY_COLOR, DIFFICULTY_LABEL } from '../core/types'
import { hexToRgba } from '../render/renderer'
import { describeKey } from '../game/input'

/* ------------------------------------------------------------------ layout */

export const Panel = React.memo(function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title?: string
  subtitle?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="muted small">{subtitle}</p>}
          </div>
          {actions && <div className="row gap-8">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
})

export const Button = React.memo(function Button({
  children,
  onClick,
  variant = 'default',
  size = 'md',
  disabled,
  title,
  type = 'button',
  full,
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: 'default' | 'primary' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
  full?: boolean
}): React.JSX.Element {
  return (
    <button
      type={type}
      title={title}
      className={`btn btn-${variant} btn-${size}${full ? ' btn-full' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  )
})

export const Field = React.memo(function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
})

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  hint,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  format?: (value: number) => string
  hint?: string
}): React.JSX.Element {
  return (
    <div className="slider-row">
      <div className="slider-top">
        <span className="field-label">{label}</span>
        <span className="mono small accent">{format ? format(value) : value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  )
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  hint?: string
}): React.JSX.Element {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-text">
        {label}
        {hint && <em>{hint}</em>}
      </span>
    </label>
  )
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  hint?: string
}): React.JSX.Element {
  return (
    <Field label={label}>
      <select value={value} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && <span className="field-hint">{hint}</span>}
    </Field>
  )
}

export function Chip({
  children,
  color,
  tone = 'soft',
}: {
  children: React.ReactNode
  color?: string
  tone?: 'soft' | 'outline'
}): React.JSX.Element {
  const style = color
    ? tone === 'outline'
      ? { borderColor: hexToRgba(color, 0.6), color }
      : { background: hexToRgba(color, 0.14), borderColor: hexToRgba(color, 0.35), color }
    : undefined
  return (
    <span className={`chip chip-${tone}`} style={style}>
      {children}
    </span>
  )
}

export function Spinner({ label }: { label?: string }): React.JSX.Element {
  return (
    <span className="spinner-wrap">
      <span className="spinner" aria-hidden="true" />
      {label && <span className="muted small">{label}</span>}
    </span>
  )
}

export function ProgressBar({ fraction, color }: { fraction: number; color?: string }): React.JSX.Element {
  const value = Math.max(0, Math.min(1, fraction))
  return (
    <div className="progress">
      <div className="progress-fill" style={{ width: `${value * 100}%`, background: color ?? undefined }} />
    </div>
  )
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string
  children: React.ReactNode
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <header className="panel-head">
          <h2>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} title="Close">
            ✕
          </Button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- difficulty */

export function DifficultyChips({
  value,
  onChange,
  disabled,
}: {
  value: Difficulty
  onChange: (value: Difficulty) => void
  disabled?: Difficulty[]
}): React.JSX.Element {
  return (
    <div className="chips">
      {DIFFICULTIES.map((difficulty) => {
        const active = difficulty === value
        const isDisabled = disabled?.includes(difficulty) ?? false
        return (
          <button
            key={difficulty}
            type="button"
            disabled={isDisabled}
            className={`difficulty-chip${active ? ' active' : ''}`}
            style={{
              borderColor: active ? DIFFICULTY_COLOR[difficulty] : 'rgba(255,255,255,0.14)',
              background: active ? hexToRgba(DIFFICULTY_COLOR[difficulty], 0.16) : undefined,
              color: active ? DIFFICULTY_COLOR[difficulty] : undefined,
            }}
            onClick={() => onChange(difficulty)}
          >
            {DIFFICULTY_LABEL[difficulty]}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ stats */

export function Stat({ label, value, hint, color }: { label: string; value: React.ReactNode; hint?: string; color?: string }): React.JSX.Element {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={color ? { color } : undefined}>
        {value}
      </span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  )
}

/* ------------------------------------------------------------------ keycaps */

/** A click-to-rebind key chip: click, press a key, done. Escape cancels the capture. */
export function KeyCap({
  label,
  onCapture,
  onClear,
}: {
  label: string
  onCapture: (code: string) => void
  onClear?: () => void
}): React.JSX.Element {
  const [capturing, setCapturing] = useState(false)
  useEffect(() => {
    if (!capturing) return
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      setCapturing(false)
      if (event.code === 'Escape') return
      onCapture(event.code)
    }
    const onBlur = (): void => setCapturing(false)
    window.addEventListener('keydown', onKey, { capture: true })
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      window.removeEventListener('blur', onBlur)
    }
  }, [capturing, onCapture])
  return (
    <span className="keycap-wrap">
      <button
        type="button"
        className={`keycap${capturing ? ' capturing' : ''}`}
        title={onClear ? 'Click to rebind, right-click to unbind' : 'Click to rebind'}
        onClick={() => setCapturing(true)}
        onContextMenu={(event) => {
          event.preventDefault()
          if (onClear) onClear()
        }}
      >
        {capturing ? 'press…' : describeKey(label)}
      </button>
    </span>
  )
}

export type IconName = 'back' | 'play' | 'stop' | 'undo' | 'replay' | 'fullscreen' | 'pause' | 'earlier' | 'later'

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  back: <path d="M16 10H4M9 4.5 3.5 10 9 15.5" />,
  play: <path d="M6 4.5v11l9-5.5z" fill="currentColor" />,
  stop: <rect x="5" y="5" width="10" height="10" rx="1.5" fill="currentColor" />,
  undo: <path d="M7.5 5 4 8.5 7.5 12M4.5 8.5h7a4.5 4.5 0 0 1 0 9H9" />,
  replay: <path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9M15.5 4v3.5H12" />,
  fullscreen: <path d="M4 8V4h4M12 4h4v4M16 12v4h-4M8 16H4v-4" />,
  pause: <path d="M7 4.5v11M13 4.5v11" />,
  earlier: <path d="M11 4.5 5.5 10l5.5 5.5M16 4.5 10.5 10l5.5 5.5" />,
  later: <path d="M9 4.5l5.5 5.5L9 15.5M4 4.5 9.5 10 4 15.5" />,
}

/** Small drawn icons, so they sit centred in buttons whatever the font. */
export function Icon({ name }: { name: IconName }): React.JSX.Element {
  return (
    <svg
      className="btn-icon"
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}

/** Back to the previous screen. */
export function BackButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} aria-label="Back">
      <Icon name="back" />
      Back
    </Button>
  )
}
