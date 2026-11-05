/**
 * Song title and artist from the file's own tags (ID3v2 in MP3, Vorbis comments in FLAC, OGG and
 * Opus). Phones often hand the browser a file named after a content id ("INBOUND3122…") instead
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

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.replace(/\0/g, '').trim()
  return trimmed ? trimmed : undefined
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

function decodeId3Text(frame: Uint8Array): string {
  const encoding = frame[0]
  const body = frame.subarray(1)
  if (encoding === 1) return new TextDecoder('utf-16').decode(body)
  if (encoding === 2) return new TextDecoder('utf-16be').decode(body)
  if (encoding === 3) return new TextDecoder('utf-8').decode(body)
  return new TextDecoder('latin1').decode(body)
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
