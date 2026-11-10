/**
 * Main-thread side of following the singer: checks the browser can run the model, resamples the
 * song for it and runs the worker.
 */
import type { OnsetEvent } from '../core/types'
import { SEPARATOR } from '../audio/separate'
import type { VoiceRequest, VoiceResponse } from './voiceProtocol'

/** Bump when the separation or the detector changes, so saved results are found again. */
export const VOICE_VERSION = 'voice-1'
const MODEL = 'kim-vocal-2.fp16.onnx'

let support: Promise<boolean> | null = null

/** Whether this browser has a GPU the model can use (WebGPU). Without it the wait would be minutes. */
export function canFindSinging(): Promise<boolean> {
  support ??= (async () => {
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
      return Boolean(gpu && (await gpu.requestAdapter()))
    } catch {
      return false
    }
  })()
  return support
}

async function stereoAtRate(buffer: AudioBuffer): Promise<[Float32Array, Float32Array]> {
  let source = buffer
  if (buffer.sampleRate !== SEPARATOR.rate) {
    const length = Math.ceil((buffer.length * SEPARATOR.rate) / buffer.sampleRate)
    const context = new OfflineAudioContext(Math.min(2, buffer.numberOfChannels), length, SEPARATOR.rate)
    const node = context.createBufferSource()
    node.buffer = buffer
    node.connect(context.destination)
    node.start()
    source = await context.startRendering()
  }
  const left = source.getChannelData(0).slice()
  const right = source.numberOfChannels > 1 ? source.getChannelData(1).slice() : left.slice()
  return [left, right]
}

export class VoiceCancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'VoiceCancelledError'
  }
}

/** Where the singer sings in this song. */
export async function findSinging(
  buffer: AudioBuffer,
  options: { onProgress?: (stage: string, fraction: number) => void; signal?: AbortSignal } = {},
): Promise<OnsetEvent[]> {
  const { onProgress, signal } = options
  if (signal?.aborted) throw new VoiceCancelledError()
  onProgress?.('Preparing the song', 0)
  const [left, right] = await stereoAtRate(buffer)
  if (signal?.aborted) throw new VoiceCancelledError()
  const worker = new Worker(new URL('./voice.worker.ts', import.meta.url), { type: 'module' })
  return new Promise<OnsetEvent[]>((resolve, reject) => {
    const finish = (): void => {
      worker.terminate()
      signal?.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      finish()
      reject(new VoiceCancelledError())
    }
    signal?.addEventListener('abort', abort, { once: true })
    worker.addEventListener('message', (event: MessageEvent<VoiceResponse>) => {
      const message = event.data
      if (message.type === 'progress') onProgress?.(message.stage, message.fraction)
      else if (message.type === 'result') {
        finish()
        resolve(message.onsets)
      } else {
        finish()
        reject(new Error(message.message))
      }
    })
    worker.addEventListener('error', (event) => {
      finish()
      reject(new Error(event.message || 'Finding the singing stopped unexpectedly.'))
    })
    const request: VoiceRequest = {
      type: 'find',
      jobId: 1,
      left,
      right,
      base: new URL('./voice/', document.baseURI).href,
      model: MODEL,
    }
    worker.postMessage(request, [left.buffer, right.buffer])
  })
}
