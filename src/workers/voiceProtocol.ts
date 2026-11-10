/** Messages between the singer worker and its client. */
import type { OnsetEvent } from '../core/types'

export interface VoiceRequest {
  type: 'find'
  jobId: number
  /** Stereo samples at the separator's rate. */
  left: Float32Array
  right: Float32Array
  /** URL of the voice/ folder, ending in a slash. */
  base: string
  model: string
}

export type VoiceResponse =
  | { type: 'progress'; jobId: number; stage: string; fraction: number }
  | { type: 'result'; jobId: number; onsets: OnsetEvent[] }
  | { type: 'error'; jobId: number; message: string }
