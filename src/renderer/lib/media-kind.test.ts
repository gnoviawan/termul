import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MEDIA_MAX_BYTES, MEDIA_TYPES, mediaKindForPath, mediaMimeForPath } from './media-kind'

const RUST_SERVICE = join(__dirname, '..', '..', '..', 'src-tauri', 'src', 'media_bytes.rs')

function rustRows(source: string): string[] {
  const table = source.match(/pub const MEDIA_TYPES[^=]*=\s*&\[([\s\S]*?)\];/)
  if (!table) throw new Error('MEDIA_TYPES table not found in media_bytes.rs')
  const rows = [...table[1].matchAll(/\("([^"]+)",\s*MediaKind::(\w+),\s*"([^"]+)"\)/g)]
  return rows.map(([, ext, kind, mime]) => `${ext} ${kind.toLowerCase()} ${mime}`).sort()
}

function rustCapsMib(source: string): Record<string, number> {
  const caps: Record<string, number> = {}
  for (const [, kind, mib] of source.matchAll(/MediaKind::(\w+) => (\d+) \* MIB/g)) {
    caps[kind.toLowerCase()] = Number(mib)
  }
  return caps
}

describe('media table drift between Rust and the renderer', () => {
  const source = readFileSync(RUST_SERVICE, 'utf-8')

  it('lists the same extensions, kinds, and MIME types', () => {
    const tsRows = Object.entries(MEDIA_TYPES)
      .map(([ext, { kind, mime }]) => `${ext} ${kind} ${mime}`)
      .sort()
    expect(tsRows).toEqual(rustRows(source))
  })

  it('caps each kind at the same size', () => {
    const tsCapsMib = Object.fromEntries(
      Object.entries(MEDIA_MAX_BYTES).map(([kind, bytes]) => [kind, bytes / (1024 * 1024)])
    )
    expect(tsCapsMib).toEqual(rustCapsMib(source))
  })
})

describe('mediaKindForPath / mediaMimeForPath', () => {
  it.each([
    ['/proj/out/Chart.PNG', 'image', 'image/png'],
    ['C:\\shots\\clip.MOV', 'video', 'video/quicktime'],
    ['docs/spec.pdf', 'pdf', 'application/pdf'],
    ['icon.svg', 'image', 'image/svg+xml']
  ])('%s is %s served as %s', (path, kind, mime) => {
    expect(mediaKindForPath(path)).toBe(kind)
    expect(mediaMimeForPath(path)).toBe(mime)
  })

  it.each([
    'notes.txt',
    'Makefile',
    '/proj/.png',
    'a.png/notes',
    'trick.constructor'
  ])('%s is not media', (path) => {
    expect(mediaKindForPath(path)).toBeNull()
    expect(mediaMimeForPath(path)).toBeNull()
  })
})
