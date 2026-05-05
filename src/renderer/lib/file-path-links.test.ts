import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  extractPathCandidate,
  openFilePathFromTerminal,
  resolveFilePathCandidate,
  stripLineColumnSuffix,
  trimWrappedPath
} from './file-path-links'

const mocks = vi.hoisted(() => ({
  getFileInfo: vi.fn(),
  openFile: vi.fn(),
  addEditorTab: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    getFileInfo: mocks.getFileInfo
  }
}))
vi.mock('@/stores/editor-store', () => ({
  useEditorStore: {
    getState: () => ({ openFile: mocks.openFile })
  }
}))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: {
    getState: () => ({ addEditorTab: mocks.addEditorTab })
  }
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError
  }
}))

describe('file-path-links parsing', () => {
  it('trims wrapped paths', () => {
    expect(trimWrappedPath('`src/foo.ts`')).toBe('src/foo.ts')
    expect(trimWrappedPath('"src/foo.ts"')).toBe('src/foo.ts')
    expect(trimWrappedPath('(src/foo.ts)')).toBe('src/foo.ts')
  })

  it('strips line and column suffixes', () => {
    expect(stripLineColumnSuffix('src/foo.ts:12')).toBe('src/foo.ts')
    expect(stripLineColumnSuffix('src/foo.ts:12:3')).toBe('src/foo.ts')
    expect(stripLineColumnSuffix('C:/repo/src/foo.ts:4:9')).toBe('C:/repo/src/foo.ts')
  })

  it('extracts wrapped paths with line and column suffixes', () => {
    expect(extractPathCandidate('(src/renderer/App.tsx:42:7)')).toBe('src/renderer/App.tsx')
    expect(extractPathCandidate('`./src/main.ts:3`')).toBe('./src/main.ts')
  })

  it('keeps plain file paths unchanged', () => {
    expect(extractPathCandidate('src/renderer/App.tsx')).toBe('src/renderer/App.tsx')
    expect(extractPathCandidate('./src/renderer/App.tsx')).toBe('./src/renderer/App.tsx')
  })
})

describe('file-path-links resolution', () => {
  beforeEach(() => {
    mocks.getFileInfo.mockReset()
    mocks.openFile.mockReset()
    mocks.addEditorTab.mockReset()
    mocks.toastError.mockReset()
  })

  it('resolves relative paths against terminal cwd', async () => {
    mocks.getFileInfo.mockResolvedValue({
      success: true,
      data: {
        path: '/repo/src/renderer/App.tsx',
        size: 100,
        modifiedAt: 1,
        type: 'file',
        isReadOnly: false,
        isBinary: false
      }
    })

    const result = await resolveFilePathCandidate('src/renderer/App.tsx', {
      cwd: '/repo',
      projectRoot: '/fallback'
    })

    expect(result).toEqual({
      ok: true,
      path: '/repo/src/renderer/App.tsx'
    })
    expect(mocks.getFileInfo).toHaveBeenCalledTimes(1)
    expect(mocks.getFileInfo).toHaveBeenNthCalledWith(1, '/repo/src/renderer/App.tsx')
  })

  it('returns not-file when getFileInfo reports a directory', async () => {
    mocks.getFileInfo.mockResolvedValue({
      success: true,
      data: {
        path: '/repo/src',
        size: 100,
        modifiedAt: 1,
        type: 'directory',
        isReadOnly: false,
        isBinary: false
      }
    })

    const result = await resolveFilePathCandidate('src', {
      cwd: '/repo'
    })

    expect(result).toEqual({ ok: false, reason: 'not-file' })
  })

  it('returns missing-context when relative path has no cwd or project root', async () => {
    const result = await resolveFilePathCandidate('src/App.tsx', {})

    expect(result).toEqual({ ok: false, reason: 'missing-context' })
    expect(mocks.getFileInfo).not.toHaveBeenCalled()
  })

  it('falls back to project root for relative paths when cwd resolution fails', async () => {
    mocks.getFileInfo
      .mockResolvedValueOnce({ success: false, error: 'not found' })
      .mockResolvedValueOnce({
        success: true,
        data: {
          path: '/repo/src/App.tsx',
          size: 100,
          modifiedAt: 1,
          type: 'file',
          isReadOnly: false,
          isBinary: false
        }
      })

    const result = await resolveFilePathCandidate('src/App.tsx', {
      cwd: '/tmp/shell',
      projectRoot: '/repo'
    })

    expect(result).toEqual({ ok: true, path: '/repo/src/App.tsx' })
    expect(mocks.getFileInfo).toHaveBeenCalledTimes(2)
    expect(mocks.getFileInfo).toHaveBeenNthCalledWith(1, '/tmp/shell/src/App.tsx')
    expect(mocks.getFileInfo).toHaveBeenNthCalledWith(2, '/repo/src/App.tsx')
  })

  it('rejects relative paths that escape the allowed roots', async () => {
    const result = await resolveFilePathCandidate('../../outside.ts', {
      cwd: '/repo/apps/termul',
      projectRoot: '/repo/apps/termul'
    })

    expect(result).toEqual({ ok: false, reason: 'not-found' })
    expect(mocks.getFileInfo).not.toHaveBeenCalled()
  })

  it('rejects absolute paths outside the allowed roots', async () => {
    const result = await resolveFilePathCandidate('/etc/hosts', {
      cwd: '/repo/apps/termul',
      projectRoot: '/repo/apps/termul'
    })

    expect(result).toEqual({ ok: false, reason: 'not-found' })
    expect(mocks.getFileInfo).not.toHaveBeenCalled()
  })

  it('resolves UNC paths within the allowed root', async () => {
    mocks.getFileInfo.mockResolvedValue({
      success: true,
      data: {
        path: '//server/share/workspace/src/App.tsx',
        size: 100,
        modifiedAt: 1,
        type: 'file',
        isReadOnly: false,
        isBinary: false
      }
    })

    const result = await resolveFilePathCandidate('\\\\server\\share\\workspace\\src\\App.tsx', {
      cwd: '\\\\server\\share\\workspace',
      projectRoot: '\\\\server\\share\\workspace'
    })

    expect(result).toEqual({ ok: true, path: '//server/share/workspace/src/App.tsx' })
    expect(mocks.getFileInfo).toHaveBeenCalledWith('//server/share/workspace/src/App.tsx')
  })

  it('rejects UNC paths outside the allowed root', async () => {
    const result = await resolveFilePathCandidate('\\\\server\\other-share\\secret.txt', {
      cwd: '\\\\server\\share\\workspace',
      projectRoot: '\\\\server\\share\\workspace'
    })

    expect(result).toEqual({ ok: false, reason: 'not-found' })
    expect(mocks.getFileInfo).not.toHaveBeenCalled()
  })

  it('opens the resolved file and adds an editor tab', async () => {
    mocks.getFileInfo.mockResolvedValue({
      success: true,
      data: {
        path: '/repo/src/renderer/App.tsx',
        size: 100,
        modifiedAt: 1,
        type: 'file',
        isReadOnly: false,
        isBinary: false
      }
    })

    const opened = await openFilePathFromTerminal('src/renderer/App.tsx', {
      cwd: '/repo'
    })

    expect(opened).toBe(true)
    expect(mocks.openFile).toHaveBeenCalledWith('/repo/src/renderer/App.tsx')
    expect(mocks.addEditorTab).toHaveBeenCalledWith('/repo/src/renderer/App.tsx')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('rejects missing files and shows toast during open', async () => {
    mocks.getFileInfo.mockResolvedValue({ success: false, error: 'not found' })

    await openFilePathFromTerminal('missing.ts', {
      projectRoot: '/repo'
    })

    expect(mocks.getFileInfo).toHaveBeenCalledTimes(1)
    expect(mocks.getFileInfo).toHaveBeenCalledWith('/repo/missing.ts')
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.addEditorTab).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('File not found: missing.ts')
  })

  it('shows toast and does not open when resolved target is not a file', async () => {
    mocks.getFileInfo.mockResolvedValue({
      success: true,
      data: {
        path: '/repo/src',
        size: 0,
        modifiedAt: 1,
        type: 'directory',
        isReadOnly: false,
        isBinary: false
      }
    })

    const opened = await openFilePathFromTerminal('src', { cwd: '/repo' })

    expect(opened).toBe(false)
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.addEditorTab).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('File not found: src')
  })

  it('shows toast and does not open when context is missing', async () => {
    const opened = await openFilePathFromTerminal('src/App.tsx', {})

    expect(opened).toBe(false)
    expect(mocks.getFileInfo).not.toHaveBeenCalled()
    expect(mocks.openFile).not.toHaveBeenCalled()
    expect(mocks.addEditorTab).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith('File not found: src/App.tsx')
  })
})
