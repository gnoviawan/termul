import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { describe, expect, it } from 'vitest'
import { findTreeEntry, joinTreePath, normalizeTreePath, parentTreePath } from './tree-paths'

function entry(path: string, type: DirectoryEntry['type'] = 'file'): DirectoryEntry {
  return {
    path,
    name: path.split('/').pop() ?? path,
    type,
    extension: null,
    size: 0,
    modifiedAt: 0
  }
}

describe('tree-paths', () => {
  it('normalizes separators and drops a trailing slash except on the filesystem root', () => {
    expect(normalizeTreePath('C:\\work\\app\\')).toBe('C:/work/app')
    expect(normalizeTreePath('/project/src/')).toBe('/project/src')
    expect(normalizeTreePath('/')).toBe('/')
  })

  it('returns the parent folder, `/` for a top-level path and empty without a slash', () => {
    expect(parentTreePath('/project/src/app.ts')).toBe('/project/src')
    expect(parentTreePath('C:\\work\\app.ts')).toBe('C:/work')
    expect(parentTreePath('/app.ts')).toBe('/')
    expect(parentTreePath('app.ts')).toBe('')
  })

  it('joins without a double slash under the filesystem root', () => {
    expect(joinTreePath('/project', 'a.ts')).toBe('/project/a.ts')
    expect(joinTreePath('/', 'a.ts')).toBe('/a.ts')
  })

  it('finds a loaded entry in any folder', () => {
    const contents = new Map([
      ['/project', [entry('/project/src', 'directory')]],
      ['/project/src', [entry('/project/src/app.ts')]]
    ])
    expect(findTreeEntry(contents, '/project/src/app.ts')?.name).toBe('app.ts')
    expect(findTreeEntry(contents, '/project/missing.ts')).toBeUndefined()
  })
})
