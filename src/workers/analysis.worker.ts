/**
 * Analysis worker: runs the DSP off the main thread so the UI keeps animating (and the progress
 * bar keeps updating) while a five-minute song is analysed.
 *
 * It owns exactly one job at a time. Cancellation is handled by the client terminating the worker
 * (the only reliable way to stop synchronous DSP mid-flight in a browser), so this file has no
 * cancel branch.
 */
import { analyzeSamples } from '../audio/analyze'
import type { WorkerRequestMessage, WorkerResponseMessage } from './protocol'

const post = (message: WorkerResponseMessage): void => {
  ;(self as unknown as { postMessage: (m: WorkerResponseMessage) => void }).postMessage(message)
}

self.addEventListener('message', (event: MessageEvent<WorkerRequestMessage>) => {
  const message = event.data
  if (!message || message.type !== 'analyze') return
  try {
    const result = analyzeSamples(message.mono, message.sampleRate, {
      onProgress: (stage, fraction) => post({ type: 'progress', jobId: message.jobId, stage, fraction }),
    })
    post({ type: 'result', jobId: message.jobId, result })
  } catch (error) {
    post({
      type: 'error',
      jobId: message.jobId,
      message: error instanceof Error ? error.message : String(error),
    })
  }
})
