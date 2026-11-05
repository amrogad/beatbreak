import { describe, expect, it } from 'vitest'
import { readSongTags } from './tags'
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

  it('does not use a phone content id as the title', () => {
    expect(titleFromFileName('INBOUND31223748923478923498789')).toBe('Untitled song')
    expect(titleFromFileName('01 - Mortals.flac')).toBe('01 - Mortals')
  })
})
