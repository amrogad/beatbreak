/**
 * Song title and artist from the file's own tags (ID3v2 in MP3, Vorbis comments in FLAC, OGG and
 * Opus, the iTunes `ilst` atoms in M4A/MP4, RIFF INFO in WAV). Phones often hand the browser a file named after a content id ("INBOUND3122…") instead
 * of its real name, so the tags are the only reliable title there.
 */
export interface SongTags {
  title?: string
  artist?: string
}

export async function readSongTags(file: File): Promise<SongTags> {
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer())
    if (ascii(head, 0, 3) === 'ID3') return await readId3(file, head)
    if (ascii(head, 0, 4) === 'fLaC') return await readFlac(file)
    if (ascii(head, 0, 4) === 'OggS') return readOgg(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()))
    if (ascii(head, 4, 4) === 'ftyp') return await readMp4(file)
    if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 2) === 'WA') return await readWav(file)
  } catch {
    // Unreadable tags are not an error: the file name is the fallback.
  }
  return {}
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = ''
  for (let i = start; i < start + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return out
}

/** ID3v2.4 separates several values with a NUL: "A\0B" reads "A, B". */
const clean = (value: string | undefined): string | undefined => {
  const joined = value
    ?.split('\0')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ')
  return joined ? joined : undefined
}

async function readId3(file: File, head: Uint8Array): Promise<SongTags> {
  const version = head[3]
  const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)
  const tag = new Uint8Array(await file.slice(10, 10 + Math.min(size, 16 * 1024 * 1024)).arrayBuffer())
  const tags: SongTags = {}
  let pos = 0
  while (pos + 10 <= tag.length) {
    const id = ascii(tag, pos, 4)
    if (!/^[A-Z0-9]{4}$/.test(id)) break
    const frameSize =
      version >= 4
        ? ((tag[pos + 4] & 0x7f) << 21) | ((tag[pos + 5] & 0x7f) << 14) | ((tag[pos + 6] & 0x7f) << 7) | (tag[pos + 7] & 0x7f)
        : (tag[pos + 4] << 24) | (tag[pos + 5] << 16) | (tag[pos + 6] << 8) | tag[pos + 7]
    if (frameSize <= 0 || pos + 10 + frameSize > tag.length) break
    if (id === 'TIT2' || id === 'TPE1') {
      const text = decodeId3Text(tag.subarray(pos + 10, pos + 10 + frameSize))
      if (id === 'TIT2') tags.title = clean(text)
      else tags.artist = clean(text)
    }
    pos += 10 + frameSize
  }
  return tags
}

export function decodeId3Text(frame: Uint8Array): string {
  const encoding = frame[0]
  const body = frame.subarray(1)
  if (encoding === 1) {
    // UTF-16 with a byte order mark; the browser decoder only honours a little-endian one.
    if (body[0] === 0xfe && body[1] === 0xff) return new TextDecoder('utf-16be').decode(body.subarray(2))
    return new TextDecoder('utf-16le').decode(body[0] === 0xff && body[1] === 0xfe ? body.subarray(2) : body)
  }
  if (encoding === 2) return new TextDecoder('utf-16be').decode(body)
  if (encoding === 3) return new TextDecoder('utf-8').decode(body)
  return decodeLegacy(body)
}

/**
 * Text that claims to be Latin-1. Many taggers write UTF-8 there anyway, and Arabic MP3s often
 * hold Windows-1256 bytes. Arabic words are runs of high bytes with many in 0xC1-0xDA; accented
 * Latin letters mostly stand alone between plain ones.
 */
function decodeLegacy(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    /* not UTF-8 */
  }
  let high = 0
  let joined = 0
  let letters = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] < 0x80) continue
    high++
    if ((i > 0 && bytes[i - 1] >= 0x80) || (i + 1 < bytes.length && bytes[i + 1] >= 0x80)) joined++
    if (bytes[i] >= 0xc1 && bytes[i] <= 0xda) letters++
  }
  if (high >= 3 && joined / high >= 0.6 && letters / high >= 0.25) return new TextDecoder('windows-1256').decode(bytes)
  return new TextDecoder('latin1').decode(bytes)
}

const fourCC = (view: DataView, at: number): string =>
  String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3))

/** MP4/M4A: walk the top-level atoms to `moov`, then `udta/meta/ilst` for the name and artist. */
async function readMp4(file: File): Promise<SongTags> {
  let pos = 0
  for (let atoms = 0; atoms < 64 && pos + 8 <= file.size; atoms++) {
    const header = new DataView(await file.slice(pos, pos + 16).arrayBuffer())
    let size = header.getUint32(0)
    const type = fourCC(header, 4)
    let headerSize = 8
    if (size === 1 && header.byteLength >= 16) {
      size = Number(header.getBigUint64(8))
      headerSize = 16
    } else if (size === 0) size = file.size - pos
    if (size < headerSize) break
    if (type === 'moov') {
      const moov = new Uint8Array(await file.slice(pos + headerSize, pos + Math.min(size, 16 * 1024 * 1024)).arrayBuffer())
      return readIlst(moov)
    }
    pos += size
  }
  return {}
}

function childAtom(bytes: Uint8Array, type: string, start = 0, end = bytes.length): { start: number; end: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = start
  while (pos + 8 <= end) {
    const size = view.getUint32(pos)
    if (size < 8 || pos + size > end) return null
    if (ascii(bytes, pos + 4, 4) === type) return { start: pos + 8, end: pos + size }
    pos += size
  }
  return null
}

function readIlst(moov: Uint8Array): SongTags {
  const udta = childAtom(moov, 'udta')
  const meta = udta && childAtom(moov, 'meta', udta.start, udta.end)
  // `meta` starts with 4 bytes of version and flags before its children.
  const ilst = meta && childAtom(moov, 'ilst', meta.start + 4, meta.end)
  if (!ilst) return {}
  const text = (key: string): string | undefined => {
    const item = childAtom(moov, key, ilst.start, ilst.end)
    const data = item && childAtom(moov, 'data', item.start, item.end)
    // data: 4 bytes type, 4 bytes locale, then the UTF-8 value.
    return data ? clean(new TextDecoder('utf-8').decode(moov.subarray(data.start + 8, data.end))) : undefined
  }
  const tags: SongTags = {}
  const title = text('\u00a9nam')
  const artist = text('\u00a9ART')
  if (title) tags.title = title
  if (artist) tags.artist = artist
  return tags
}

/** WAV: a RIFF `LIST` chunk of type `INFO` holds `INAM` (title) and `IART` (artist). */
async function readWav(file: File): Promise<SongTags> {
  let pos = 12
  for (let chunks = 0; chunks < 64 && pos + 8 <= file.size; chunks++) {
    const header = new DataView(await file.slice(pos, pos + 12).arrayBuffer())
    if (header.byteLength < 8) break
    const size = header.getUint32(4, true)
    if (fourCC(header, 0) === 'LIST' && header.byteLength >= 12 && fourCC(header, 8) === 'INFO') {
      const body = new Uint8Array(await file.slice(pos + 12, pos + 8 + Math.min(size, 64 * 1024)).arrayBuffer())
      const view = new DataView(body.buffer)
      const tags: SongTags = {}
      let at = 0
      while (at + 8 <= body.length) {
        const key = ascii(body, at, 4)
        const length = view.getUint32(at + 4, true)
        const value = clean(decodeLegacy(body.subarray(at + 8, Math.min(body.length, at + 8 + length))))
        if (key === 'INAM' && value) tags.title = value
        if (key === 'IART' && value) tags.artist = value
        at += 8 + length + (length % 2)
      }
      return tags
    }
    pos += 8 + size + (size % 2)
  }
  return {}
}

async function readFlac(file: File): Promise<SongTags> {
  let pos = 4
  for (let block = 0; block < 64; block++) {
    const header = new Uint8Array(await file.slice(pos, pos + 4).arrayBuffer())
    if (header.length < 4) break
    const last = (header[0] & 0x80) !== 0
    const type = header[0] & 0x7f
    const length = (header[1] << 16) | (header[2] << 8) | header[3]
    if (type === 4) return readVorbisComments(new Uint8Array(await file.slice(pos + 4, pos + 4 + length).arrayBuffer()), 0)
    if (last) break
    pos += 4 + length
  }
  return {}
}

function readOgg(bytes: Uint8Array): SongTags {
  for (const marker of ['\x03vorbis', 'OpusTags']) {
    const at = indexOf(bytes, marker)
    if (at >= 0) return readVorbisComments(bytes, at + marker.length)
  }
  return {}
}

function indexOf(bytes: Uint8Array, text: string): number {
  outer: for (let i = 0; i + text.length <= bytes.length; i++) {
    for (let k = 0; k < text.length; k++) if (bytes[i + k] !== text.charCodeAt(k)) continue outer
    return i
  }
  return -1
}

/** A Vorbis comment block: vendor string, then "KEY=value" entries, all little-endian lengths. */
function readVorbisComments(bytes: Uint8Array, start: number): SongTags {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const utf8 = new TextDecoder('utf-8')
  let pos = start
  const vendor = view.getUint32(pos, true)
  pos += 4 + vendor
  const count = view.getUint32(pos, true)
  pos += 4
  const tags: SongTags = {}
  for (let i = 0; i < count && pos + 4 <= bytes.length; i++) {
    const length = view.getUint32(pos, true)
    pos += 4
    const entry = utf8.decode(bytes.subarray(pos, pos + length))
    pos += length
    const eq = entry.indexOf('=')
    if (eq < 0) continue
    const key = entry.slice(0, eq).toUpperCase()
    if (key === 'TITLE' && !tags.title) tags.title = clean(entry.slice(eq + 1))
    if (key === 'ARTIST' && !tags.artist) tags.artist = clean(entry.slice(eq + 1))
  }
  return tags
}
