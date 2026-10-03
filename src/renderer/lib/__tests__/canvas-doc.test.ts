/**
 * Canvas doc picker tests (OpenPencil canvas mode, review finding 8b).
 *
 * Pins the "Open canvas" resolution rule used by the command palette:
 * `.op` FILES only (case-insensitive), alphabetical, first match — and no
 * match when the project root carries none (the palette then toasts "no
 * .op document" and never calls openCanvas).
 */

import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { describe, expect, it } from 'vitest'
import { pickCanvasDoc } from '../canvas-doc'

function file(path: string): DirectoryEntry {
  const parts = path.split('/')
  return { path, name: parts[parts.length - 1] ?? path, type: 'file' }
}

function directory(path: string): DirectoryEntry {
  const parts = path.split('/')
  return { path, name: parts[parts.length - 1] ?? path, type: 'directory' }
}

describe('pickCanvasDoc', () => {
  it('returns the alphabetically-first .op file', () => {
    const picked = pickCanvasDoc([file('/proj/poster.op'), file('/proj/design.op')])
    expect(picked?.path).toBe('/proj/design.op')
  })

  it('matches the .op extension case-insensitively', () => {
    const picked = pickCanvasDoc([file('/proj/DESIGN.OP')])
    expect(picked?.path).toBe('/proj/DESIGN.OP')
  })

  it('never picks directories (even .op-named ones) or non-.op files', () => {
    expect(pickCanvasDoc([directory('/proj/assets.op'), file('/proj/README.md')])).toBeUndefined()
  })

  it('returns undefined when the listing carries no .op file (no openCanvas call)', () => {
    expect(pickCanvasDoc([file('/proj/a.ts'), directory('/proj/src')])).toBeUndefined()
    expect(pickCanvasDoc([])).toBeUndefined()
  })
})
