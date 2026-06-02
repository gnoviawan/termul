import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from './editor-store'

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    getFileInfo: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn()
  }
}))

vi.mock('@/lib/editor-content-flush', () => ({
  flushEditorContent: vi.fn()
}))

import { filesystemApi } from '@/lib/api'
import { flushEditorContent } from '@/lib/editor-content-flush'

describe('editor-store saveFile', () => {
  const path = '/project/file.ts'

  beforeEach(() => {
    vi.mocked(flushEditorContent).mockReset()
    vi.mocked(flushEditorContent).mockResolvedValue(undefined)
    vi.mocked(filesystemApi.writeFile).mockReset()
    vi.mocked(filesystemApi.writeFile).mockResolvedValue({ success: true, data: undefined })

    useEditorStore.setState({
      openFiles: new Map([
        [
          path,
          {
            filePath: path,
            content: 'latest',
            originalContent: 'original',
            isDirty: true,
            language: 'typescript',
            lastModified: 0,
            viewMode: 'code',
            cursorPosition: { line: 1, col: 1 },
            scrollTop: 0,
            operationStatus: 'idle'
          }
        ]
      ]),
      activeFilePath: path
    })
  })

  it('flushes editor content before writing to disk', async () => {
    vi.mocked(flushEditorContent).mockImplementation(async () => {
      useEditorStore.getState().updateContent(path, 'flushed-latest')
    })

    const saved = await useEditorStore.getState().saveFile(path)

    expect(flushEditorContent).toHaveBeenCalledWith(path)
    expect(filesystemApi.writeFile).toHaveBeenCalledWith(path, 'flushed-latest')
    expect(filesystemApi.writeFile).toHaveBeenCalledTimes(1)
    expect(vi.mocked(flushEditorContent).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(filesystemApi.writeFile).mock.invocationCallOrder[0]
    )
    expect(saved).toBe(true)
    expect(useEditorStore.getState().openFiles.get(path)?.isDirty).toBe(false)
  })
})
