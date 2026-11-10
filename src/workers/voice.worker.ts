/**
 * Finds the singing in a song: isolates the vocals with the model on the GPU, then finds the sung
 * notes in them. Runs off the main thread; the client ends the worker to cancel.
 */
import { analyzeSamples } from '../audio/analyze'
import { SEPARATOR, separateVocals } from '../audio/separate'
import { detectVoiceNotes, singerOnsets } from '../audio/voice'
import type { VoiceRequest, VoiceResponse } from './voiceProtocol'

const post = (message: VoiceResponse): void => {
  ;(self as unknown as { postMessage: (m: VoiceResponse) => void }).postMessage(message)
}

const CACHE = 'beatbreak-voice-1'

/** The model's bytes, from this browser's cache or downloaded once with progress. */
async function modelBytes(url: string, onProgress: (fraction: number) => void): Promise<ArrayBuffer> {
  const cache = typeof caches !== 'undefined' ? await caches.open(CACHE).catch(() => null) : null
  const hit = await cache?.match(url)
  if (hit) return hit.arrayBuffer()
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`The singer model could not be downloaded (${response.status}).`)
  onProgress(0)
  const total = Number(response.headers.get('content-length')) || 0
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    received += value.length
    if (total) onProgress(received / total)
  }
  const bytes = new Uint8Array(received)
  let at = 0
  for (const part of parts) {
    bytes.set(part, at)
    at += part.length
  }
  await cache?.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => undefined)
  return bytes.buffer
}

self.addEventListener('message', async (event: MessageEvent<VoiceRequest>) => {
  const message = event.data
  if (!message || message.type !== 'find') return
  const { jobId, base } = message
  const progress = (stage: string, fraction: number): void => post({ type: 'progress', jobId, stage, fraction })
  try {
    const ort = await import('onnxruntime-web/webgpu')
    ort.env.wasm.wasmPaths = base
    ort.env.wasm.numThreads = 1
    const model = await modelBytes(`${base}${message.model}`, (f) => progress('Downloading the singer model', f))
    progress('Starting the GPU', 0)
    const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['webgpu'] })
    const input = session.inputNames[0]
    const output = session.outputNames[0]
    const shape = [1, 4, SEPARATOR.bins, SEPARATOR.block]
    const vocals = await separateVocals(
      message.left,
      message.right,
      async (block) => {
        const result = await session.run({ [input]: new ort.Tensor('float32', block, shape) })
        const data = (await result[output].getData()) as Float32Array
        result[output].dispose()
        return data
      },
      (f) => progress('Isolating the vocals', f),
    )
    await session.release()
    progress('Finding the singing', 0)
    const attacks = analyzeSamples(vocals, SEPARATOR.rate).onsets
    const onsets = singerOnsets(attacks, detectVoiceNotes(vocals, SEPARATOR.rate))
    post({ type: 'result', jobId, onsets })
  } catch (error) {
    post({ type: 'error', jobId, message: error instanceof Error ? error.message : String(error) })
  }
})
