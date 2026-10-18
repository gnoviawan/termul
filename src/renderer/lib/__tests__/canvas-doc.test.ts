/**
 * Pins the canvas document rule used by the "Open canvas" command and the
 * file explorer: `.figcraft` files only (case-insensitive), alphabetical,
 * first match.
 */

import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { describe, expect, it } from 'vitest'
import { isCanvasDocPath, pickCanvasDoc } from '../canvas-doc'

function entry(path: string, type: DirectoryEntry['type']): DirectoryEntry {
  const name = path.split('/').at(-1) ?? path
  return { path, name, type, extension: null, size: 0, modifiedAt: 0 }
}

const file = (path: string): DirectoryEntry => entry(path, 'file')
const directory = (path: string): DirectoryEntry => entry(path, 'directory')

describe('pickCanvasDoc', () => {
  it('returns the alphabetically-first .figcraft file', () => {
    const picked = pickCanvasDoc([file('/proj/poster.figcraft'), file('/proj/design.figcraft')])
    expect(picked?.path).toBe('/proj/design.figcraft')
  })

  it('matches the extension case-insensitively', () => {
    expect(pickCanvasDoc([file('/proj/DESIGN.FIGCRAFT')])?.path).toBe('/proj/DESIGN.FIGCRAFT')
  })

  it('never picks directories, legacy .op documents or other files', () => {
    expect(
      pickCanvasDoc([
        directory('/proj/assets.figcraft'),
        file('/proj/old.op'),
        file('/proj/README.md')
      ])
    ).toBeUndefined()
    expect(pickCanvasDoc([])).toBeUndefined()
  })
})

describe('isCanvasDocPath', () => {
  it('accepts .figcraft paths only', () => {
    expect(isCanvasDocPath('C:/proj/design.figcraft')).toBe(true)
    expect(isCanvasDocPath('/proj/design.op')).toBe(false)
    expect(isCanvasDocPath('/proj/figcraft.md')).toBe(false)
  })
})
