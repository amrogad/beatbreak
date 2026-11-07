import React from 'react'
import { STORAGE_KEY } from '../store/settings'

interface ErrorBoundaryState {
  error: Error | null
  copied: boolean
}

/**
 * Last line of defence. A render error in any screen would otherwise leave the user staring at a
 * blank page with no way forward; here they get the actual message and two safe ways out.
 *
 * Deliberately not a reset-on-route-change boundary: the recovery actions reload or clear only
 * the volatile in-memory song cache, never the user's library (IndexedDB is untouched).
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, copied: false }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error, copied: false }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Keep the details in the console for a bug report; the UI stays calm and actionable.
    console.error('[beatbreak] unhandled render error', error, info.componentStack)
  }

  private reload = (): void => {
    window.location.reload()
  }

  private goHome = (): void => {
    // Drop the in-memory bundles (a corrupt AudioBuffer or chart cannot poison the next render),
    // then reload into a clean Home. The persisted library is untouched.
    this.setState({ error: null })
    window.location.assign(new URL('./', document.baseURI).toString())
  }

  /** A setting that breaks a screen would break it on every reload: this is the way out. Songs stay. */
  private resetSettings = (): void => {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* storage blocked: the reload still helps */
    }
    window.location.assign(new URL('./', document.baseURI).toString())
  }

  private copyDetails = (): void => {
    const { error } = this.state
    if (!error) return
    const text = [`${error.name}: ${error.message}`, error.stack ?? '', `Page: ${location.href}`, `Browser: ${navigator.userAgent}`].join('\n')
    void navigator.clipboard?.writeText(text).then(() => this.setState({ copied: true })).catch(() => undefined)
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="app">
        <div className="page narrow" style={{ paddingTop: 60 }}>
          <section className="panel">
            <h1>Something broke in the interface</h1>
            <p className="muted mt-8">
              The game hit an unexpected error while rendering. Your library, charts and scores are stored in this
              browser and have not been touched.
            </p>
            <pre
              className="mono small mt-16"
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: 12,
                maxHeight: 220,
                overflow: 'auto',
              }}
            >
              {error.name}: {error.message}
            </pre>
            <div className="row gap-8 wrap mt-16">
              <button type="button" className="btn btn-primary" onClick={this.goHome}>
                Back to home
              </button>
              <button type="button" className="btn btn-ghost" onClick={this.reload}>
                Reload the page
              </button>
              <button type="button" className="btn btn-ghost" onClick={this.copyDetails}>
                {this.state.copied ? 'Copied' : 'Copy details'}
              </button>
            </div>
            <p className="muted small mt-16">
              If this keeps coming back, reset the settings. Your songs, charts and scores stay.
            </p>
            <div className="row gap-8 wrap mt-8">
              <button type="button" className="btn btn-danger btn-sm" onClick={this.resetSettings}>
                Reset settings
              </button>
            </div>
          </section>
        </div>
      </div>
    )
  }
}
