/**
 * Pins the canvas document rule used by the "Open canvas" command and the
 * file explorer: `.figcraft` files only (case-insensitive), alphabetical,
 * first match.
 */

import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { describe, expect, it } from 'vitest'
import {
  canvasDocFile,
  isCanvasDocPath,
  pickCanvasDoc,
  projectRelativePath,
  sameCanvasDoc
} from '../canvas-doc'

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

describe('sameCanvasDoc', () => {
  it('folds case for Windows paths, drive-letter and UNC alike', () => {
    expect(sameCanvasDoc(String.raw`C:\Proj\Design.figcraft`, 'c:/proj/design.figcraft')).toBe(true)
    expect(
      sameCanvasDoc(String.raw`\\Server\Share\Design.figcraft`, '//server/share/design.figcraft')
    ).toBe(true)
    expect(
      sameCanvasDoc(
        String.raw`\\?\UNC\Server\Share\Design.figcraft`,
        '//server/share/design.figcraft'
      )
    ).toBe(true)
  })

  it('keeps POSIX paths case-sensitive', () => {
    expect(sameCanvasDoc('/proj/Design.figcraft', '/proj/design.figcraft')).toBe(false)
  })
})

describe('projectRelativePath', () => {
  it('strips the project root, folding case and separators for drive paths', () => {
    expect(projectRelativePath('C:/p/design/app.figcraft', 'c:\\P\\')).toBe('design/app.figcraft')
    expect(projectRelativePath('/home/u/p/a.figcraft', '/home/u/p')).toBe('a.figcraft')
  })

  it('treats a verbatim Windows root like its plain spelling, in any slash style', () => {
    const root = String.raw`\\?\D:\Work\Proj`
    expect(projectRelativePath('//?/d:/work/proj/design.figcraft', root)).toBe('design.figcraft')
    expect(projectRelativePath(String.raw`\\?\D:\Work\Proj/a.figcraft`, 'd:/work/proj')).toBe(
      'a.figcraft'
    )
    expect(projectRelativePath('D:/Work/Proj/sub/a.figcraft', root)).toBe('sub/a.figcraft')
    expect(
      projectRelativePath(String.raw`\\?\UNC\srv\share\p\a.figcraft`, String.raw`\\srv\share\p`)
    ).toBe('a.figcraft')
  })

  it('keeps the full path for a document outside the root or with no root', () => {
    expect(projectRelativePath('/home/u/other/a.figcraft', '/home/u/p')).toBe(
      '/home/u/other/a.figcraft'
    )
    expect(projectRelativePath('/home/u/pp/a.figcraft', '/home/u/p')).toBe('/home/u/pp/a.figcraft')
    expect(projectRelativePath('C:\\p\\a.figcraft', undefined)).toBe('C:/p/a.figcraft')
  })
})

describe('canvasDocFile', () => {
  const project = { name: 'termul', path: 'D:/git/termul' }

  it('names the file by its stem and reports the path save_file reports', () => {
    expect(canvasDocFile(String.raw`\?\D:\git\termul\design.figcraft`, project)).toEqual({
      name: 'design',
      path: 'design.figcraft',
      location: 'termul'
    })
    expect(canvasDocFile('D:/git/termul/ui/Poster.FIGCRAFT', project)).toMatchObject({
      name: 'Poster',
      path: 'ui/Poster.FIGCRAFT'
    })
  })

  it('never hands the editor an absolute path', () => {
    expect(canvasDocFile('E:/elsewhere/design.figcraft', project).path).toBe('design.figcraft')
    expect(canvasDocFile('/home/u/p/design.figcraft', undefined)).toEqual({
      name: 'design',
      path: 'design.figcraft',
      location: null
    })
  })
})
