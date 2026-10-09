import { describe, expect, it } from 'vitest'
import { buildGitDecorations } from './explorer-git-decorations'

describe('buildGitDecorations', () => {
  it('maps repo-relative status paths onto absolute tree paths', () => {
    const git = buildGitDecorations('/project', [
      { path: 'src/app.ts', status: 'modified', staged: false },
      { path: 'README.md', status: 'added', staged: true },
      { path: 'old.txt', status: 'deleted', staged: false }
    ])
    expect(git.getFileStatus('/project/src/app.ts')).toBe('modified')
    expect(git.getFileStatus('/project/README.md')).toBe('added')
    expect(git.getFileStatus('/project/old.txt')).toBe('deleted')
    expect(git.getFileStatus('/project/clean.ts')).toBeUndefined()
    expect(git.isDirDirty('/project/src')).toBe(true)
    expect(git.isDirDirty('/project/docs')).toBe(false)
  })

  it('marks everything under an untracked folder as untracked', () => {
    const git = buildGitDecorations('/project', [
      { path: 'new-dir/', status: 'untracked', staged: false }
    ])
    expect(git.isDirDirty('/project/new-dir')).toBe(true)
    expect(git.getFileStatus('/project/new-dir/a/b.ts')).toBe('untracked')
    expect(git.isDirDirty('/project/new-dir/a')).toBe(true)
  })

  it('treats a staged-only row as modified and keeps the stronger status', () => {
    const git = buildGitDecorations('/project', [
      { path: 'a.ts', status: 'staged', staged: true },
      { path: 'b.ts', status: 'modified', staged: false },
      { path: 'b.ts', status: 'added', staged: true }
    ])
    expect(git.getFileStatus('/project/a.ts')).toBe('modified')
    expect(git.getFileStatus('/project/b.ts')).toBe('added')
  })

  it('handles Windows separators and a trailing slash on the root', () => {
    const git = buildGitDecorations('C:\\work\\project\\', [
      { path: 'src/main.rs', status: 'modified', staged: false }
    ])
    expect(git.getFileStatus('C:\\work\\project\\src\\main.rs')).toBe('modified')
    expect(git.isDirDirty('C:/work/project/src')).toBe(true)
  })

  it('returns no decorations without statuses', () => {
    const git = buildGitDecorations('/project', undefined)
    expect(git.getFileStatus('/project/a.ts')).toBeUndefined()
    expect(git.isDirDirty('/project')).toBe(false)
  })
})
