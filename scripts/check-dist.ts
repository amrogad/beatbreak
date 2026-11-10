/**
 * Deploy check: proves the production bundle can be hosted from a subpath (GitHub Pages project
 * sites) as well as a domain root.
 *
 * The failure this guards against is silent: root-absolute asset URLs or service-worker precache
 * entries look fine on localhost and 404 the moment the app is served from /<repo>/. Run after
 * `npm run build` (the CI workflow does this before publishing).
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const dist = resolve(process.cwd(), 'dist')
let failures = 0

function check(label: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/index.html is missing — run `npm run build` first.')
  process.exit(1)
}

const html = readFileSync(join(dist, 'index.html'), 'utf8')
check('index.html references assets relatively', !/(?:src|href)="\/(?!\/)/.test(html), 'no root-absolute src/href')
check('module script is emitted', /<script[^>]+type="module"/.test(html))
check('stylesheet is emitted', /<link[^>]+rel="stylesheet"/.test(html))

const sw = readFileSync(join(dist, 'sw.js'), 'utf8')
const literal = sw.match(/const PRECACHE_MANIFEST = ("(?:[^"\\]|\\.)*")/)?.[1] ?? ''
let entries: { url: string }[] = []
try {
  // The build injects a JSON *string* (double stringify); parse the literal, then its contents.
  entries = JSON.parse(JSON.parse(literal))
} catch {
  // If the injection shape changes, fail loudly below.
}
check('service worker has an injected precache manifest', entries.length > 0, `${entries.length} entries`)
check(
  'precache entries are scope-relative, never root-absolute',
  entries.length > 0 && entries.every((entry) => !entry.url.startsWith('/')),
)
check(
  'precache includes the app shell',
  entries.some((entry) => entry.url === 'index.html'),
)
check(
  'precache includes the built js and css',
  entries.some((entry) => /^assets\/.*\.js$/.test(entry.url)) && entries.some((entry) => /^assets\/.*\.css$/.test(entry.url)),
)
check('manifest is present', existsSync(join(dist, 'manifest.webmanifest')))
check('icons are present', ['icon-192.png', 'icon-512.png', 'maskable-512.png'].every((f) => existsSync(join(dist, 'icons', f))))
check('robots.txt is present', existsSync(join(dist, 'robots.txt')))
check('no source maps are shipped', !readdirSync(join(dist, 'assets')).some((f) => f.endsWith('.map')))

// Every precached file must actually exist — a typo would 404 on install and quietly degrade
// offline support.
const missing = entries.filter((entry) => !existsSync(join(dist, entry.url.replace(/^\.\//, ''))))
check('every precache entry exists on disk', missing.length === 0, missing.map((m) => m.url).join(', '))

// The menu theme is fetched only with an empty library, and the singer files only when a player
// turns that on, so neither is part of the first load.
const totalBytes = (dir: string): number =>
  readdirSync(dir).filter((name) => name !== 'music' && name !== 'voice').reduce((sum, name) => {
    const full = join(dir, name)
    return sum + (statSync(full).isDirectory() ? totalBytes(full) : statSync(full).size)
  }, 0)
const mb = totalBytes(dist) / (1024 * 1024)
check('bundle stays small enough for a static host', mb < 3, `${mb.toFixed(2)} MB`)

if (failures > 0) {
  console.error(`\n${failures} deploy check(s) failed`)
  process.exit(1)
}
console.log('\nall deploy checks passed')
