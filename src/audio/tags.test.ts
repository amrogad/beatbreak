import { describe, expect, it } from 'vitest'
import { decodeId3Text, readSongTags } from './tags'
import { titleFromFileName } from '../store/library'

const le32 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]
const utf8 = (text: string): number[] => [...new TextEncoder().encode(text)]

describe('song tags', () => {
  it('reads title and artist from a FLAC Vorbis comment block', async () => {
    const entries = ['TITLE=Mortals', 'ARTIST=Warriyo'].map(utf8)
    const comment = [...le32(3), ...utf8('ref'), ...le32(entries.length), ...entries.flatMap((e) => [...le32(e.length), ...e])]
    const streamInfo = [0x00, 0, 0, 34, ...new Array(34).fill(0)]
    const block = [0x84, (comment.length >> 16) & 255, (comment.length >> 8) & 255, comment.length & 255, ...comment]
    const file = new File([new Uint8Array([...utf8('fLaC'), ...streamInfo, ...block])], 'INBOUND3122')
    expect(await readSongTags(file)).toEqual({ title: 'Mortals', artist: 'Warriyo' })
  })

  it('reads an ID3v2.3 title', async () => {
    const text = [3, ...utf8('All Rise')]
    const frame = [...utf8('TIT2'), 0, 0, 0, text.length, 0, 0, ...text]
    const header = [...utf8('ID3'), 3, 0, 0, 0, 0, 0, frame.length]
    const file = new File([new Uint8Array([...header, ...frame])], 'x.mp3')
    expect((await readSongTags(file)).title).toBe('All Rise')
  })

  it('decodes big-endian UTF-16, joins NUL-separated values and reads Arabic Windows-1256', () => {
    expect(decodeId3Text(new Uint8Array([1, 0xfe, 0xff, 0, 0x41, 0, 0x42]))).toBe('AB')
    expect(decodeId3Text(new Uint8Array([1, 0xff, 0xfe, 0x41, 0, 0x42, 0]))).toBe('AB')
    // "عمرو" in Windows-1256.
    expect(decodeId3Text(new Uint8Array([0, 0xda, 0xe3, 0xd1, 0xe6]))).toBe('عمرو')
    expect(decodeId3Text(new Uint8Array([0, ...utf8('Café')]))).toBe('Café')
  })

  it('splits several artists in one ID3 frame', async () => {
    const text = [3, ...utf8('Artist A'), 0, ...utf8('Artist B')]
    const frame = [...utf8('TPE1'), 0, 0, 0, text.length, 0, 0, ...text]
    const header = [...utf8('ID3'), 3, 0, 0, 0, 0, 0, frame.length]
    expect((await readSongTags(new File([new Uint8Array([...header, ...frame])], 'x.mp3'))).artist).toBe('Artist A, Artist B')
  })

  it('reads the name and artist from an M4A file', async () => {
    const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]
    const atom = (type: number[], body: number[]): number[] => [...be32(body.length + 8), ...type, ...body]
    const data = (text: string) => atom(utf8('data'), [0, 0, 0, 1, 0, 0, 0, 0, ...utf8(text)])
    const ilst = atom(utf8('ilst'), [...atom([0xa9, ...utf8('nam')], data('Mortals')), ...atom([0xa9, ...utf8('ART')], data('Warriyo'))])
    const moov = atom(utf8('moov'), atom(utf8('udta'), atom(utf8('meta'), [0, 0, 0, 0, ...ilst])))
    const file = new File([new Uint8Array([...atom(utf8('ftyp'), utf8('M4A 0000')), ...atom(utf8('mdat'), [1, 2, 3, 4]), ...moov])], 'INBOUND1.m4a')
    expect(await readSongTags(file)).toEqual({ title: 'Mortals', artist: 'Warriyo' })
  })

  it('reads the name and artist from a WAV INFO list', async () => {
    const sub = (key: string, text: string) => {
      const value = [...utf8(text), 0]
      return [...utf8(key), ...le32(value.length), ...value, ...(value.length % 2 ? [0] : [])]
    }
    const info = [...utf8('INFO'), ...sub('INAM', 'Mortals'), ...sub('IART', 'Warriyo')]
    const fmt = [...utf8('fmt '), ...le32(16), ...new Array(16).fill(0)]
    const list = [...utf8('LIST'), ...le32(info.length), ...info]
    const body = [...utf8('WAVE'), ...fmt, ...list]
    const file = new File([new Uint8Array([...utf8('RIFF'), ...le32(body.length), ...body])], 'x.wav')
    expect(await readSongTags(file)).toEqual({ title: 'Mortals', artist: 'Warriyo' })
  })

  it('does not use a phone content id as the title', () => {
    expect(titleFromFileName('INBOUND31223748923478923498789')).toBe('Untitled song')
    expect(titleFromFileName('01 - Mortals.flac')).toBe('01 - Mortals')
  })
})
