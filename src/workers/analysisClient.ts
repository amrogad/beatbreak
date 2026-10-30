/**
 * Main-thread client for the analysis worker.
 *
 * Rules it enforces:
 *  - one job at a time (the UI only ever analyses one song);
 *  - cancellation really cancels: the worker is terminated, which is the only way to interrupt
 *    synchronous DSP, and a fresh worker is created for the next job;
 *  - a worker that crashes or stops reporting is failed loudly (with a watchdog) instead of
 *    silently re-running the analysis on the main thread. After a transfer the samples are
 *    detached from this thread — the old fallback would then analyse an empty array and freeze
 *    the tab mid-import. The UI offers a Retry, which re-decodes from the source file.
 *  - if workers are unavailable (rare, but some embedded webviews block them) the same analysis
 *    runs on the main thread after yielding once so the spinner can paint. The result is identical
 *    because both paths call the same `analyzeSamples`.
 */
import { analyzeSamples } from '../audio/analyze'
import type { AnalysisResult } from '../core/types'
import type { WorkerRequestMessage, WorkerResponseMessage } from './protocol'

export class AnalysisCancelledError extends Error {
  constructor() {
    super('Analysis cancelled.')
    this.name = 'AnalysisCancelledError'
  }
}

/** The worker crashed or stopped responding; the import can be retried from the decoded file. */
export class AnalysisWorkerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnalysisWorkerError'
  }
}

/** How long the worker may go without a single message before it is considered stuck. */
const WORKER_STALL_MS = 30_000

export interface AnalyzeOptions {
  onProgress?: (stage: string, fraction: number) => void
  /**
   * True when the caller just allocated `mono` and will not use it again: the buffer is then
   * transferred to the worker instead of copied (saves ~50 MB for a long song).
   */
  owned?: boolean
  signal?: AbortSignal
}

export class AnalysisClient {
  private worker: Worker | null = null
  private nextJobId = 1
  private pending: {
    jobId: number
    resolve: (result: AnalysisResult) => void
    reject: (error: Error) => void
    onProgress?: (stage: string, fraction: number) => void
    abort?: () => void
  } | null = null
  private useWorker: boolean

  constructor(options: { useWorker?: boolean } = {}) {
    this.useWorker = options.useWorker ?? typeof Worker !== 'undefined'
  }

  get isBusy(): boolean {
    return this.pending !== null
  }

  async analyze(mono: Float32Array, sampleRate: number, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
    if (this.pending) throw new Error('The analyser is already running; cancel the current job first.')
    if (options.signal?.aborted) throw new AnalysisCancelledError()
    if (!this.useWorker) return this.runInline(mono, sampleRate, options)
    let transferred = false
    try {
      return await this.runInWorker(mono, sampleRate, options, () => {
        transferred = true
      })
    } catch (error) {
      this.terminateWorker()
      this.pending = null
      if (error instanceof AnalysisCancelledError) throw error
      // Fall back to the main thread only while the samples are still ours — e.g. the browser
      // refused to construct a Worker at all. After a transfer the array is detached, so the
      // fallback would analyse nothing: fail loudly and let the UI offer Retry instead.
      if (!transferred) return this.runInline(mono, sampleRate, options)
      throw error instanceof AnalysisWorkerError
        ? error
        : new AnalysisWorkerError(error instanceof Error ? error.message : String(error))
    }
  }

  cancel(): void {
    const pending = this.pending
    this.pending = null
    this.terminateWorker()
    if (pending) {
      pending.abort?.()
      pending.reject(new AnalysisCancelledError())
    }
  }

  dispose(): void {
    this.cancel()
  }

  private runInline(mono: Float32Array, sampleRate: number, options: AnalyzeOptions): Promise<AnalysisResult> {
    return new Promise<AnalysisResult>((resolve, reject) => {
      let settled = false
      const abort = (): void => {
        if (settled) return
        settled = true
        reject(new AnalysisCancelledError())
      }
      this.pending = { jobId: 0, resolve, reject, onProgress: options.onProgress, abort }
      options.signal?.addEventListener('abort', abort, { once: true })
      // Yield once so React can paint the "analysing" state before the CPU gets busy.
      setTimeout(() => {
        if (settled) return
        try {
          const result = analyzeSamples(mono, sampleRate, { onProgress: options.onProgress })
          settled = true
          this.pending = null
          resolve(result)
        } catch (error) {
          settled = true
          this.pending = null
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      }, 30)
    })
  }

  private runInWorker(
    mono: Float32Array,
    sampleRate: number,
    options: AnalyzeOptions,
    onTransfer: () => void,
  ): Promise<AnalysisResult> {
    return new Promise<AnalysisResult>((resolve, reject) => {
      let worker: Worker
      try {
        worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      const jobId = this.nextJobId++
      let watchdog: ReturnType<typeof setTimeout> | null = null
      const armWatchdog = (): void => {
        if (watchdog) clearTimeout(watchdog)
        watchdog = setTimeout(() => {
          cleanup()
          reject(
            new AnalysisWorkerError(
              'The analysis worker stopped responding. This is usually memory pressure on a very long file — ' +
                'retry, or import a shorter edit of the song.',
            ),
          )
        }, WORKER_STALL_MS)
      }
      const onMessage = (event: MessageEvent<WorkerResponseMessage>): void => {
        const message = event.data
        if (!message || message.jobId !== jobId) return
        if (message.type === 'progress') {
          armWatchdog()
          this.pending?.onProgress?.(message.stage, message.fraction)
          return
        }
        if (message.type === 'result') {
          cleanup()
          resolve(message.result)
          return
        }
        cleanup()
        reject(new AnalysisWorkerError(message.message))
      }
      const onError = (event: ErrorEvent): void => {
        cleanup()
        reject(new AnalysisWorkerError(event.message || 'The analysis worker crashed.'))
      }
      const abort = (): void => {
        cleanup()
        reject(new AnalysisCancelledError())
      }
      const cleanup = (): void => {
        if (watchdog) {
          clearTimeout(watchdog)
          watchdog = null
        }
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
        options.signal?.removeEventListener('abort', abort)
        if (this.worker === worker) this.worker = null
        this.pending = null
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      options.signal?.addEventListener('abort', abort, { once: true })
      this.worker = worker
      this.pending = { jobId, resolve, reject, onProgress: options.onProgress, abort }
      const request: WorkerRequestMessage = { type: 'analyze', jobId, mono, sampleRate }
      if (options.owned) {
        onTransfer()
        worker.postMessage(request, [mono.buffer])
      } else {
        // Structured clone copies the samples; the caller keeps its array.
        worker.postMessage(request)
      }
      armWatchdog()
    })
  }

  private terminateWorker(): void {
    if (!this.worker) return
    try {
      this.worker.terminate()
    } catch {
      /* already gone */
    }
    this.worker = null
  }
}
