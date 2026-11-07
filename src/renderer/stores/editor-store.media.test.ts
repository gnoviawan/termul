import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    getFileInfo: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn()
  }
}))

vi.mock('@/lib/editor-content-flush', () => ({
  flushEditorContent: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

import { filesystemApi } from '@/lib/api'
import { useEditorStore } from './editor-store'

const NOW = 1_700_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.mocked(filesystemApi.readFile).mockReset()
  vi.mocked(filesystemApi.writeFile).mockReset()
  vi.mocked(filesystemApi.getFileInfo).mockReset()
})

afterEach(() => {
  useEditorStore.setState({ openFiles: new Map(), activeFilePath: null })
  vi.useRealTimers()
})

describe('editor-store media tabs', () => {
  it.each([
    ['/project/out/shot.png', 'image'],
    ['/project/out/clip.mp4', 'video'],
    ['/project/out/report.pdf', 'pdf']
  ] as const)('opens %s as a %s tab without reading it', async (path, kind) => {
    await useEditorStore.getState().openFile(path)

    expect(filesystemApi.readFile).not.toHaveBeenCalled()
    expect(useEditorStore.getState().openFiles.get(path)).toEqual({
      kind,
      filePath: path,
      isDirty: false,
      lastModified: NOW,
      operationStatus: 'idle',
      revision: 0
    })
    expect(useEditorStore.getState().activeFilePath).toBe(path)
  })

  it('opens an SVG as editable text with the rendered preview first', async () => {
    vi.mocked(filesystemApi.readFile).mockResolvedValue({
      success: true,
      data: { content: '<svg/>', encoding: 'utf-8', size: 6, modifiedAt: 5 }
    })

    await useEditorStore.getState().openFile('/project/icon.svg')

    expect(useEditorStore.getState().openFiles.get('/project/icon.svg')).toMatchObject({
      kind: 'text',
      content: '<svg/>',
      language: 'xml',
      viewMode: 'preview'
    })
  })

  it('opens a binary text read as an unsupported tab with its size', async () => {
    vi.mocked(filesystemApi.readFile).mockResolvedValue({
      success: false,
      error: 'Binary file cannot be displayed',
      code: 'BINARY_FILE'
    })
    vi.mocked(filesystemApi.getFileInfo).mockResolvedValue({
      success: true,
      data: {
        path: '/project/app.exe',
        size: 2048,
        modifiedAt: 1,
        type: 'file',
        isReadOnly: false,
        isBinary: true
      }
    })

    await useEditorStore.getState().openFile('/project/app.exe')

    expect(useEditorStore.getState().openFiles.get('/project/app.exe')).toEqual({
      kind: 'unsupported',
      filePath: '/project/app.exe',
      isDirty: false,
      lastModified: NOW,
      operationStatus: 'idle',
      reason: 'binary',
      size: 2048
    })
  })

  it('opens a binary file without a size when the host refuses file info', async () => {
    vi.mocked(filesystemApi.readFile).mockResolvedValue({
      success: false,
      error: 'Binary file cannot be displayed',
      code: 'BINARY_FILE'
    })
    vi.mocked(filesystemApi.getFileInfo).mockResolvedValue({
      success: false,
      error: 'forbidden',
      code: 'FORBIDDEN'
    })

    await useEditorStore.getState().openFile('/project/app.exe')

    expect(useEditorStore.getState().openFiles.get('/project/app.exe')).toMatchObject({
      kind: 'unsupported',
      reason: 'binary'
    })
    expect(useEditorStore.getState().openFiles.get('/project/app.exe')).not.toHaveProperty('size')
  })

  it('opens a text file over the read cap as too large, with size and cap', async () => {
    vi.mocked(filesystemApi.readFile).mockResolvedValue({
      success: false,
      error: 'File too large (3145728 bytes, max 1048576)',
      code: 'FILE_TOO_LARGE'
    })

    await useEditorStore.getState().openFile('/project/dump.log')

    expect(useEditorStore.getState().openFiles.get('/project/dump.log')).toMatchObject({
      kind: 'unsupported',
      reason: 'too-large',
      size: 3_145_728,
      limit: 1_048_576
    })
  })

  it('still rejects a text read that fails for any other reason', async () => {
    vi.mocked(filesystemApi.readFile).mockResolvedValue({
      success: false,
      error: 'permission denied',
      code: 'READ_ERROR'
    })

    await expect(useEditorStore.getState().openFile('/project/secret.txt')).rejects.toThrow(
      'permission denied'
    )
    expect(useEditorStore.getState().openFiles.size).toBe(0)
  })

  it('never writes a media tab, and ignores edits and cursor moves on it', async () => {
    await useEditorStore.getState().openFile('/project/shot.png')
    const before = useEditorStore.getState().openFiles.get('/project/shot.png')

    useEditorStore.getState().updateContent('/project/shot.png', 'text')
    useEditorStore.getState().updateCursorPosition('/project/shot.png', 4, 2)
    useEditorStore.getState().setViewMode('/project/shot.png', 'preview')
    const saved = await useEditorStore.getState().saveFile('/project/shot.png')

    expect(saved).toBe(true)
    expect(filesystemApi.writeFile).not.toHaveBeenCalled()
    expect(useEditorStore.getState().openFiles.get('/project/shot.png')).toBe(before)
  })

  it('bumps the revision on reload instead of reading the file', async () => {
    await useEditorStore.getState().openFile('/project/shot.png')

    await useEditorStore.getState().reloadFile('/project/shot.png')
    await useEditorStore.getState().reloadFile('/project/shot.png')

    expect(filesystemApi.readFile).not.toHaveBeenCalled()
    expect(useEditorStore.getState().openFiles.get('/project/shot.png')).toMatchObject({
      kind: 'image',
      revision: 2
    })
  })
})
