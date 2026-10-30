/** Message shapes shared by the analysis worker and its main-thread client. */
import type { AnalysisResult } from '../core/types'

export interface AnalyzeRequestMessage {
  type: 'analyze'
  jobId: number
  /** Mono samples. Sent as a copy (or a transferred owned buffer) — see `AnalysisClient`. */
  mono: Float32Array
  sampleRate: number
}

export type WorkerRequestMessage = AnalyzeRequestMessage

export interface AnalyzeProgressMessage {
  type: 'progress'
  jobId: number
  stage: string
  fraction: number
}

export interface AnalyzeResultMessage {
  type: 'result'
  jobId: number
  result: AnalysisResult
}

export interface AnalyzeErrorMessage {
  type: 'error'
  jobId: number
  message: string
}

export type WorkerResponseMessage = AnalyzeProgressMessage | AnalyzeResultMessage | AnalyzeErrorMessage
