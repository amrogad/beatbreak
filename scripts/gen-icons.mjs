/**
 * Generates the PWA icons (192/512 + a maskable 512) with zero dependencies.
 *
 * A tiny PNG encoder: RGBA rows → zlib deflate → IHDR/IDAT/IEND chunks with CRC32. The artwork is
 * drawn procedurally: the Beatbreak mark is four lane bars in the lane colours with a hit line,
 * which is the same identity the game uses in its own UI.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const LANE_COLORS = [
  [0x22, 0xe0, 0xff], // left  — cyan
  [0xa0, 0x6b, 0xff], // down  — violet
  [0xff, 0x3e, 0xa5], // up    — magenta
  [0xff, 0xc7, 0x3a], // right — amber
]
const BG_TOP = [0x0a, 0x0d, 0x20]
const BG_BOTTOM = [0x05, 0x06, 0x0e]

function crc32(buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i]
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
]

/** Draw the mark. `inset` shrinks the artwork for maskable safe zones. */
function render(size, inset) {
  const rgba = Buffer.alloc(size * size * 4)
  const art = size * (1 - inset * 2)
  const artX = size * inset
  const artY = size * inset
  const barCount = 4
  const gap = art * 0.045
  const barW = (art - gap * (barCount + 1)) / barCount
  const radius = Math.max(2, Math.round(art * 0.03))
  const hitLineY = artY + art * 0.74

  const insideRounded = (x, y, rx, ry, rw, rh, r) => {
    if (x < rx || y < ry || x > rx + rw || y > ry + rh) return false
    const dx = Math.min(Math.max(x, rx + r), rx + rw - r)
    const dy = Math.min(Math.max(y, ry + r), ry + rh - r)
    const distX = x - dx
    const distY = y - dy
    return distX * distX + distY * distY <= r * r
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4
      const t = y / Math.max(1, size - 1)
      let [r, g, b] = mix(BG_TOP, BG_BOTTOM, t)

      // Subtle radial glow behind the mark.
      const cx = size / 2
      const cy = size / 2
      const distance = Math.hypot(x - cx, y - cy) / (size * 0.7)
      if (distance < 1) {
        const glow = (1 - distance) ** 3 * 0.22
        r = Math.min(255, Math.round(r + glow * 40))
        g = Math.min(255, Math.round(g + glow * 22))
        b = Math.min(255, Math.round(b + glow * 90))
      }

      // Lane bars, each at a different height so the mark reads as a chart.
      const heights = [0.52, 0.78, 0.62, 0.9]
      for (let bar = 0; bar < barCount; bar++) {
        const bx = artX + gap + bar * (barW + gap)
        const bh = art * heights[bar]
        const by = artY + art - bh
        if (insideRounded(x, y, bx, by, barW, bh, radius)) {
          const color = LANE_COLORS[bar]
          const shade = 0.86 + 0.14 * (1 - (y - by) / Math.max(1, bh))
          r = Math.round(color[0] * shade)
          g = Math.round(color[1] * shade)
          b = Math.round(color[2] * shade)
        }
      }

      // Hit line across the bars.
      const lineH = Math.max(2, Math.round(art * 0.022))
      if (y >= hitLineY - lineH / 2 && y <= hitLineY + lineH / 2 && x >= artX + gap * 0.5 && x <= artX + art - gap * 0.5) {
        r = 0xf2
        g = 0xf7
        b = 0xff
      }

      rgba[index] = r
      rgba[index + 1] = g
      rgba[index + 2] = b
      rgba[index + 3] = 255
    }
  }
  return encodePng(size, size, rgba)
}

const outputDir = resolve(process.cwd(), 'public', 'icons')
mkdirSync(outputDir, { recursive: true })

const targets = [
  { file: 'icon-192.png', size: 192, inset: 0.1 },
  { file: 'icon-512.png', size: 512, inset: 0.1 },
  { file: 'maskable-512.png', size: 512, inset: 0.2 },
  { file: 'favicon-64.png', size: 64, inset: 0.08 },
]

for (const target of targets) {
  const png = render(target.size, target.inset)
  const path = resolve(outputDir, target.file)
  writeFileSync(path, png)
  console.log(`wrote ${path} (${(png.length / 1024).toFixed(1)} KB)`)
}
void dirname
