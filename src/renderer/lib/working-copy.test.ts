import { describe, expect, it } from 'vitest'
import type { WorkspaceTab } from '@/stores/workspace-store'
import type { Project } from '@/types/project'
import {
  normalizePath,
  pickedWorkingCopy,
  resolveActiveWorkingCopy,
  type TabPathSources,
  tabPath,
  workingCopyOf
} from './working-copy'

type ProjectPaths = Pick<Project, 'path' | 'worktrees'>

function worktree(id: string, path: string) {
  return { id, name: id, branch: `branch-${id}`, path, createdAt: '2026-01-01T00:00:00.000Z' }
}

const project: ProjectPaths = {
  path: 'E:/p',
  worktrees: [
    worktree('a', 'E:/p/.termul/worktrees/a'),
    worktree('b', 'E:/p/.termul/worktrees/b'),
    worktree('ext', 'D:/elsewhere/wt')
  ]
}

const noSources: TabPathSources = { sessionCwd: () => null, terminalCwd: () => null }

describe('normalizePath', () => {
  it('makes every Windows form of one folder agree', () => {
    for (const form of ['E:\\Proj\\', 'e:/proj', '\\\\?\\E:\\Proj', '//?/E:/PROJ/', 'E:/Proj//']) {
      expect(normalizePath(form)).toBe('e:/proj')
    }
  })

  it('handles verbatim UNC and plain UNC, case-folded', () => {
    expect(normalizePath('\\\\?\\UNC\\srv\\share\\p')).toBe('//srv/share/p')
    expect(normalizePath('//?/UNC/Srv/Share/P')).toBe('//srv/share/p')
    expect(normalizePath('\\\\SRV\\Share\\P\\')).toBe('//srv/share/p')
    expect(normalizePath('//srv//share///p')).toBe('//srv/share/p')
  })

  it('handles mixed separators and duplicate slashes', () => {
    expect(normalizePath('E:\\a/b\\\\c//d')).toBe('e:/a/b/c/d')
  })

  it('keeps case for POSIX paths and collapses slashes', () => {
    expect(normalizePath('/Home/A//b/')).toBe('/Home/A/b')
  })

  it('resolves dot segments without climbing above a root', () => {
    expect(normalizePath('E:/a/./b/../c')).toBe('e:/a/c')
    expect(normalizePath('E:/../x')).toBe('e:/x')
    expect(normalizePath('/a/../../b')).toBe('/b')
    expect(normalizePath('//srv/share/../../x')).toBe('//srv/share/x')
  })

  it('keeps trailing slash only on roots', () => {
    expect(normalizePath('/')).toBe('/')
    expect(normalizePath('C:/')).toBe('c:/')
    expect(normalizePath('C:\\')).toBe('c:/')
    expect(normalizePath('\\\\?\\C:\\')).toBe('c:/')
    expect(normalizePath('/a/b/')).toBe('/a/b')
  })

  it('keeps the empty path empty', () => {
    expect(normalizePath('')).toBe('')
  })
})

describe('workingCopyOf', () => {
  it('resolves a path inside a listed worktree in any form', () => {
    const wc = workingCopyOf('\\\\?\\E:\\p\\.termul\\worktrees\\a\\src', project)
    expect(wc).toEqual({
      state: 'resolved',
      kind: 'worktree',
      key: 'e:/p/.termul/worktrees/a',
      path: 'E:/p/.termul/worktrees/a',
      worktreeId: 'a'
    })
  })

  it('resolves the project folder, matching case-insensitively on Windows', () => {
    expect(workingCopyOf('//?/e:/P/src/x.ts', project)).toEqual({
      state: 'resolved',
      kind: 'project',
      key: 'e:/p',
      path: 'E:/p',
      worktreeId: null
    })
  })

  it('treats an equal path as contained', () => {
    expect(workingCopyOf('E:/p/', project)).toMatchObject({ kind: 'project' })
    expect(workingCopyOf('E:/p/.termul/worktrees/b', project)).toMatchObject({ worktreeId: 'b' })
  })

  it('prefers the deeper working copy (worktree nested in project)', () => {
    expect(workingCopyOf('E:/p/.termul/worktrees/a/x/y', project)).toMatchObject({
      kind: 'worktree',
      worktreeId: 'a'
    })
  })

  it('resolves a worktree listed outside the project folder', () => {
    expect(workingCopyOf('D:\\Elsewhere\\WT\\f.ts', project)).toMatchObject({
      kind: 'worktree',
      worktreeId: 'ext',
      path: 'D:/elsewhere/wt'
    })
  })

  it('does not match a sibling prefix', () => {
    expect(workingCopyOf('E:/p-other/x', project)).toBeNull()
    expect(workingCopyOf('E:/proj-other/x', { path: 'E:/proj' })).toBeNull()
  })

  it('returns unresolved for an unlisted managed worktree, never the project', () => {
    const wc = workingCopyOf('E:/p/.termul/worktrees/gone/x', project)
    expect(wc).toEqual({
      state: 'unresolved',
      key: 'e:/p/.termul/worktrees/gone',
      path: 'E:/p/.termul/worktrees/gone'
    })
    expect(workingCopyOf('\\\\?\\E:\\P\\.termul\\worktrees\\Gone', project)).toMatchObject({
      state: 'unresolved',
      key: 'e:/p/.termul/worktrees/gone',
      path: 'E:/P/.termul/worktrees/Gone'
    })
  })

  it('keeps the managed directory itself on the project folder', () => {
    expect(workingCopyOf('E:/p/.termul/worktrees', project)).toMatchObject({
      state: 'resolved',
      kind: 'project'
    })
    expect(workingCopyOf('E:/p/.termul/other/x', project)).toMatchObject({ kind: 'project' })
  })

  it('returns unresolved when the project has no listed worktrees at all', () => {
    expect(workingCopyOf('E:/p/.termul/worktrees/a/x', { path: 'E:/p' })).toMatchObject({
      state: 'unresolved'
    })
  })

  it('returns null outside every working copy', () => {
    expect(workingCopyOf('D:/elsewhere/f.ts', project)).toBeNull()
  })

  it('returns null for empty paths and unusable projects', () => {
    expect(workingCopyOf('', project)).toBeNull()
    expect(workingCopyOf(null, project)).toBeNull()
    expect(workingCopyOf('E:/p/x', {})).toBeNull()
    expect(workingCopyOf('E:/p/x', null)).toBeNull()
    expect(workingCopyOf('E:/p/x', { path: '', worktrees: [] })).toBeNull()
  })

  it('works for a project folder at a drive root', () => {
    const root: ProjectPaths = { path: 'C:\\' }
    expect(workingCopyOf('C:/x/y', root)).toMatchObject({ kind: 'project', key: 'c:/' })
    expect(workingCopyOf('c:/.termul/worktrees/g/x', root)).toMatchObject({
      state: 'unresolved',
      key: 'c:/.termul/worktrees/g'
    })
  })

  it('keeps POSIX paths case-sensitive', () => {
    const posix: ProjectPaths = { path: '/Home/Proj', worktrees: [worktree('w', '/Home/Wt')] }
    expect(workingCopyOf('/Home/Proj/src', posix)).toMatchObject({ kind: 'project' })
    expect(workingCopyOf('/home/proj/src', posix)).toBeNull()
    expect(workingCopyOf('/Home/Wt/x', posix)).toMatchObject({ worktreeId: 'w' })
  })

  it('prefers the project folder over a worktree entry of equal depth', () => {
    const dup: ProjectPaths = { path: 'E:/p', worktrees: [worktree('same', 'e:\\P\\')] }
    expect(workingCopyOf('E:/p/x', dup)).toMatchObject({ kind: 'project', worktreeId: null })
  })

  it('handles UNC project folders', () => {
    const unc: ProjectPaths = { path: '\\\\srv\\share\\p' }
    expect(workingCopyOf('\\\\?\\UNC\\SRV\\share\\p\\a', unc)).toMatchObject({
      kind: 'project',
      key: '//srv/share/p'
    })
    expect(workingCopyOf('//srv/share/pp/a', unc)).toBeNull()
  })

  it('keeps the UNC server and share as the root when resolving parent segments', () => {
    const unc: ProjectPaths = { path: '//srv/share/repo' }
    expect(normalizePath('//srv/share/../repo')).toBe('//srv/share/repo')
    expect(normalizePath('\\\\srv\\share\\..')).toBe('//srv/share')
    expect(normalizePath('\\\\srv\\share\\..\\..\\Repo\\x')).toBe('//srv/share/repo/x')
    expect(normalizePath('//srv/share/a/../../../b')).toBe('//srv/share/b')
    expect(normalizePath('//srv/../x')).toBe('//x')
    expect(workingCopyOf('//srv/share/../repo/a', unc)).toMatchObject({
      kind: 'project',
      key: '//srv/share/repo'
    })
    expect(workingCopyOf('\\\\srv\\share\\..', unc)).toBeNull()
  })
})

describe('tabPath', () => {
  const sources: TabPathSources = {
    sessionCwd: (id) => ({ s1: 'E:/p/.termul/worktrees/a', empty: '' })[id],
    terminalCwd: (id) => ({ t1: 'E:/p/src' })[id]
  }

  it('maps path-bearing tabs', () => {
    expect(tabPath({ type: 'agent-chat', id: 'x', sessionId: 's1' }, sources)).toBe(
      'E:/p/.termul/worktrees/a'
    )
    expect(tabPath({ type: 'terminal', id: 'x', terminalId: 't1' }, sources)).toBe('E:/p/src')
    expect(tabPath({ type: 'editor', id: 'x', filePath: 'E:/p/a.ts' }, sources)).toBe('E:/p/a.ts')
  })

  it('returns null for empty or missing values', () => {
    expect(tabPath({ type: 'agent-chat', id: 'x', sessionId: 'empty' }, sources)).toBeNull()
    expect(tabPath({ type: 'agent-chat', id: 'x', sessionId: 'nope' }, sources)).toBeNull()
    expect(tabPath({ type: 'terminal', id: 'x', terminalId: 'nope' }, sources)).toBeNull()
    expect(tabPath({ type: 'editor', id: 'x', filePath: '' }, sources)).toBeNull()
  })

  it('returns null for tabs without a path', () => {
    const tabs: WorkspaceTab[] = [
      { type: 'browser', id: 'x', browserTabId: 'b' },
      { type: 'canvas', id: 'x', projectId: 'p', docPath: 'E:/p/d.pen' },
      { type: 'git', id: 'x', cwd: 'E:/p' },
      { type: 'git-history', id: 'x', cwd: 'E:/p' }
    ]
    for (const tab of tabs) expect(tabPath(tab, sources)).toBeNull()
    expect(tabPath(null, sources)).toBeNull()
    expect(tabPath(undefined, sources)).toBeNull()
  })
})

describe('pickedWorkingCopy', () => {
  it('returns the listed worktree the pick names, in any path form', () => {
    expect(pickedWorkingCopy(project, '\\\\?\\E:\\P\\.termul\\worktrees\\b\\')).toMatchObject({
      state: 'resolved',
      kind: 'worktree',
      worktreeId: 'b'
    })
  })

  it('falls back to the project folder for pruned, unlisted, empty or missing picks', () => {
    for (const pick of ['E:/p/.termul/worktrees/gone', 'D:/nowhere', '', null, undefined]) {
      expect(pickedWorkingCopy(project, pick)).toEqual({
        state: 'resolved',
        kind: 'project',
        key: 'e:/p',
        path: 'E:/p',
        worktreeId: null
      })
    }
  })

  it('does not treat the project path as a worktree pick', () => {
    expect(pickedWorkingCopy(project, 'e:\\p')).toMatchObject({ kind: 'project' })
  })

  it('returns null for a project without a path and no worktrees', () => {
    expect(pickedWorkingCopy({}, 'E:/p')).toBeNull()
    expect(pickedWorkingCopy(null, null)).toBeNull()
    expect(pickedWorkingCopy({ path: undefined, worktrees: [] }, null)).toBeNull()
  })

  it('still resolves a listed worktree when the project has no path', () => {
    expect(pickedWorkingCopy({ worktrees: [worktree('w', 'D:/wt')] }, 'd:\\WT')).toMatchObject({
      kind: 'worktree',
      worktreeId: 'w'
    })
  })
})

describe('resolveActiveWorkingCopy', () => {
  const sources: TabPathSources = {
    sessionCwd: (id) =>
      ({
        inA: '\\\\?\\E:\\p\\.termul\\worktrees\\a\\src',
        gone: 'E:/p/.termul/worktrees/gone/x',
        outside: 'D:/nowhere/x'
      })[id],
    terminalCwd: (id) => ({ term: 'E:/p/.termul/worktrees/a' })[id]
  }
  const pick = 'E:/p/.termul/worktrees/b'

  it('uses the tab path over the pick (chat, terminal, editor)', () => {
    const tabs: WorkspaceTab[] = [
      { type: 'agent-chat', id: 'x', sessionId: 'inA' },
      { type: 'terminal', id: 'x', terminalId: 'term' },
      { type: 'editor', id: 'x', filePath: 'E:/p/.termul/worktrees/a/f.ts' }
    ]
    for (const activeTab of tabs) {
      expect(
        resolveActiveWorkingCopy({ project, activeTab, pickedPath: pick, sources })
      ).toMatchObject({ state: 'resolved', kind: 'worktree', worktreeId: 'a' })
    }
  })

  it('falls to the pick when the tab has no path', () => {
    const tabs: Array<WorkspaceTab | null> = [
      { type: 'browser', id: 'x', browserTabId: 'b' },
      { type: 'canvas', id: 'x', projectId: 'p', docPath: 'E:/p/d.pen' },
      { type: 'git', id: 'x', cwd: 'E:/p/.termul/worktrees/a' },
      { type: 'git-history', id: 'x', cwd: 'E:/p/.termul/worktrees/a' },
      null
    ]
    for (const activeTab of tabs) {
      expect(
        resolveActiveWorkingCopy({ project, activeTab, pickedPath: pick, sources })
      ).toMatchObject({ kind: 'worktree', worktreeId: 'b' })
    }
  })

  it('falls to the project folder when there is no pick', () => {
    expect(
      resolveActiveWorkingCopy({ project, activeTab: null, pickedPath: null, sources: noSources })
    ).toMatchObject({ kind: 'project' })
  })

  it('falls to the pick when the tab path is outside the project', () => {
    expect(
      resolveActiveWorkingCopy({
        project,
        activeTab: { type: 'agent-chat', id: 'x', sessionId: 'outside' },
        pickedPath: pick,
        sources
      })
    ).toMatchObject({ worktreeId: 'b' })
  })

  it('returns an unresolved result as is, ignoring the pick', () => {
    expect(
      resolveActiveWorkingCopy({
        project,
        activeTab: { type: 'agent-chat', id: 'x', sessionId: 'gone' },
        pickedPath: pick,
        sources
      })
    ).toEqual({
      state: 'unresolved',
      key: 'e:/p/.termul/worktrees/gone',
      path: 'E:/p/.termul/worktrees/gone'
    })
  })

  it('returns null for a project without a path', () => {
    expect(
      resolveActiveWorkingCopy({
        project: {},
        activeTab: null,
        pickedPath: null,
        sources: noSources
      })
    ).toBeNull()
  })
})
