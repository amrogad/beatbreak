import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Injects a precache manifest (list of emitted files with a revision hash) into the
 * service worker after the bundle is written. Keeps PWA support dependency free while
 * still giving us a real offline-first precache of hashed assets.
 */
function serviceWorkerPrecache(): import('vite').Plugin {
  return {
    name: 'sw-precache',
    apply: 'build',
    async closeBundle() {
      // Node builtins resolved lazily so tsconfig never needs @types/node.
      const fs = await import('node:fs')
      const path = await import('node:path')
      const crypto = await import('node:crypto')
      const dist = path.resolve(process.cwd(), 'dist')
      const swPath = path.join(dist, 'sw.js')
      if (!fs.existsSync(swPath)) return

      const skip = new Set(['sw.js', 'manifest.webmanifest', 'robots.txt', 'vercel.json', '_headers'])
      const walk = (dir: string, base = ''): string[] => {
        const out: string[] = []
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = base ? `${base}/${entry.name}` : entry.name
          if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel))
          else if (!skip.has(rel)) out.push(rel)
        }
        return out
      }

      // The menu theme is big and only plays with an empty library, so nobody downloads it up front.
      const files = walk(dist).filter((rel) => !rel.startsWith('music/') && !rel.startsWith('voice/'))
      const manifest = files.map((rel) => {
        const bytes = fs.readFileSync(path.join(dist, rel))
        const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12)
        // Relative URLs, resolved against the service worker's scope. Root-absolute ('/asset.js')
        // breaks any deployment under a subpath (e.g. user.github.io/pulsegrid/).
        return { url: rel, revision: hash }
      })
      // Cache version: derived from the emitted files, so every deploy gets a fresh cache and the
      // activate handler can drop the previous build instead of accumulating stale hashed assets.
      const buildHash = crypto
        .createHash('sha256')
        .update(manifest.map((entry) => `${entry.url}:${entry.revision}`).sort().join('|'))
        .digest('hex')
        .slice(0, 12)

      let sw = fs.readFileSync(swPath, 'utf8')
      sw = sw.replace('__BUILD_VERSION__', buildHash)
      // The runtime does `JSON.parse(PRECACHE_MANIFEST)`, so the injected value must be a JSON
      // *string* (double stringify): injecting the bare array literal made the parse throw, and the
      // service worker silently fell back to "no precache" while still looking installed.
      sw = sw.replace('"__PRECACHE_MANIFEST__"', JSON.stringify(JSON.stringify(manifest)))
      fs.writeFileSync(swPath, sw)
      console.log(`[beatbreak] service worker precache: ${manifest.length} entries`)
    },
  }
}

/** The vocal model, pinned to one revision and checked by hash. */
const VOICE_MODEL = {
  name: 'kim-vocal-2.fp16.onnx',
  url: 'https://huggingface.co/uddompang/kamvox-voice-separator/resolve/c207cd6ae4dd478a65a95a8517d68ed938532795/kim-vocal-2.fp16.onnx',
  sha256: 'e421ee5c61e77b030c27da6f2afffce4549a4cd5b5b80fd992ed4de60635acc4',
}
const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']

/**
 * Files for following the singer, served from voice/: the model and the onnxruntime WebGPU
 * runtime. They are large and only fetched when a player turns the option on, so they stay out of
 * the bundle and the precache. The model is downloaded once into .cache/ at build time.
 */
function voiceAssets(): import('vite').Plugin {
  const sources = async (): Promise<Record<string, string>> => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const crypto = await import('node:crypto')
    const cacheDir = path.resolve(process.cwd(), '.cache', 'voice')
    const model = path.join(cacheDir, VOICE_MODEL.name)
    const hashOf = (file: string): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    if (!fs.existsSync(model) || hashOf(model) !== VOICE_MODEL.sha256) {
      fs.mkdirSync(cacheDir, { recursive: true })
      const response = await fetch(VOICE_MODEL.url)
      if (!response.ok) throw new Error(`voice model download failed: ${response.status}`)
      fs.writeFileSync(model, new Uint8Array(await response.arrayBuffer()))
      if (hashOf(model) !== VOICE_MODEL.sha256) throw new Error('voice model hash does not match')
    }
    const ortDir = path.resolve(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist')
    return Object.fromEntries([[VOICE_MODEL.name, model], ...ORT_FILES.map((name) => [name, path.join(ortDir, name)])])
  }
  return {
    name: 'voice-assets',
    configureServer(server) {
      const files = sources()
      server.middlewares.use(async (req, res, next) => {
        const match = req.url?.match(/\/voice\/([\w.-]+)$/)
        if (!match) return next()
        const file = (await files)[match[1]]
        if (!file) return next()
        const fs = await import('node:fs')
        res.setHeader('Content-Type', file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
        fs.createReadStream(file).pipe(res)
      })
    },
    async writeBundle(options) {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const out = path.join(options.dir ?? path.resolve(process.cwd(), 'dist'), 'voice')
      fs.mkdirSync(out, { recursive: true })
      for (const [name, file] of Object.entries(await sources())) fs.copyFileSync(file, path.join(out, name))
    },
  }
}

/**
 * Local builds only: circle-mode runs POST their play log here and it is saved to
 * ../pulsegrid-testdata/playlogs, so a run can be checked without the player doing anything.
 */
function playLog(): import('vite').Plugin {
  const handler: import('vite').Connect.NextHandleFunction = (req, res, next) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/__playlog')) return next()
    // Only this app's own pages: JSON from the same local origin, at most a few MB.
    const origin = req.headers.origin
    const host = req.headers.host ?? ''
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json') || (origin && origin !== `http://${host}`)) {
      res.statusCode = 403
      res.end()
      return
    }
    const LIMIT = 4 * 1024 * 1024
    let body = ''
    let tooBig = false
    req.on('data', (chunk) => {
      if (tooBig) return
      body += chunk
      if (body.length > LIMIT) tooBig = true
    })
    req.on('end', async () => {
      const fs = await import('node:fs')
      const path = await import('node:path')
      try {
        if (tooBig) throw new Error('too big')
        const log = JSON.parse(body)
        const dir = path.resolve(process.cwd(), '..', 'pulsegrid-testdata', 'playlogs')
        fs.mkdirSync(dir, { recursive: true })
        const clean = (value: unknown, max: number): string => String(value ?? '').replace(/[^\w-]+/g, '_').slice(0, max)
        const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${clean(log.song, 40)}-${clean(log.mode, 8)}-${clean(log.difficulty, 8)}.json`
        fs.writeFileSync(path.join(dir, path.basename(name)), body)
        res.statusCode = 204
      } catch {
        res.statusCode = 400
      }
      res.end()
    })
  }
  return {
    name: 'play-log',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), voiceAssets(), serviceWorkerPrecache(), playLog()],
  resolve: {
    // The build that loads its WebAssembly from voice/ instead of bundling it.
    alias: { 'onnxruntime-web/webgpu': '/node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs' },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  worker: { format: 'es' },
  server: { port: 5173, host: '127.0.0.1' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
})
