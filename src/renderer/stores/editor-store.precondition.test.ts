import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorStore } from './editor-store'

vi.mock('@/lib/api', () => ({
  filesystemApi: { getFileInfo: vi.fn(), readFile: vi.fn(), writeFile: vi.fn() }
}))
vi.mock('@/lib/editor-content-flush', () => ({ flushEditorContent: vi.fn() }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { warning: vi.fn(), error: vi.fn() }) }))

import { toast } from 'sonner'
import { filesystemApi } from '@/lib/api'
import { flushEditorContent } from '@/lib/editor-content-flush'
import { sha256Hex } from '@/lib/sha256-hex'

const path = '/project/file.ts'
const readHash = 'a'.repeat(64)

function open(contentHash: string | undefined) {
  useEditorStore.setState({
    openFiles: new Map([
      [
        path,
        {
          filePath: path,
          content: 'edited',
          kind: 'text',
          originalContent: 'original',
          isDirty: true,
          language: 'typescript',
          lastModified: 0,
          viewMode: 'code',
          cursorPosition: { line: 1, col: 1 },
          scrollTop: 0,
          operationStatus: 'idle',
          ...(contentHash ? { contentHash, tracksHash: true as const } : {})
        }
      ]
    ]),
    activeFilePath: path
  })
}

describe('editor-store save preconditions (web host)', () => {
  beforeEach(() => {
    vi.mocked(toast).mockClear()
    vi.mocked(flushEditorContent).mockReset()
    vi.mocked(flushEditorContent).mockResolvedValue(undefined)
    vi.mocked(filesystemApi.writeFile).mockReset()
    vi.mocked(filesystemApi.readFile).mockReset()
  })

  it('saves over the hash it read and carries the saved content hash into the next save', async () => {
    open(readHash)
    vi.mocked(filesystemApi.writeFile).mockResolvedValue({ success: true, data: undefined })

    expect(await useEditorStore.getState().saveFile(path)).toBe(true)

    expect(filesystemApi.writeFile).toHaveBeenCalledWith(path, 'edited', {
      expected: { sha256: readHash }
    })
    const saved = useEditorStore.getState().openFiles.get(path)
    expect(saved?.contentHash).toBe(sha256Hex('edited'))
    expect(saved?.externalConflict).toBe(false)

    useEditorStore.getState().updateContent(path, 'edited again')
    await useEditorStore.getState().saveFile(path)
    expect(filesystemApi.writeFile).toHaveBeenLastCalledWith(path, 'edited again', {
      expected: { sha256: sha256Hex('edited') }
    })
  })

  it('a refused save (file changed on disk) keeps the buffer dirty, raises the external-change notice and flags the conflict', async () => {
    open(readHash)
    vi.mocked(filesystemApi.writeFile).mockResolvedValue({
      success: false,
      error: 'file changed',
      code: 'PRECONDITION_FAILED'
    })

    expect(await useEditorStore.getState().saveFile(path)).toBe(false)

    const file = useEditorStore.getState().openFiles.get(path)
    expect(file).toMatchObject({ isDirty: true, content: 'edited', externalConflict: true })
    expect(file?.contentHash).toBe(readHash)
    expect(toast).toHaveBeenCalledWith(
      'File changed externally',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Reload' }) })
    )
  })

  it('Reload from the notice takes the disk version, replacing the dirty buffer and its hash', async () => {
    open(readHash)
    vi.mocked(filesystemApi.writeFile).mockResolvedValue({
      success: false,
      error: 'file changed',
      code: 'PRECONDITION_FAILED'
    })
    await useEditorStore.getState().saveFile(path)
    const [, options] = vi.mocked(toast).mock.calls[0]
    vi.mocked(filesystemApi.readFile).mockResolvedValue({
      success: true,
      data: {
        content: 'on disk',
        encoding: 'utf-8',
        size: 7,
        modifiedAt: 5,
        contentHash: 'b'.repeat(64)
      }
    })

    options?.action && 'onClick' in options.action && options.action.onClick?.({} as never)
    await vi.waitFor(() =>
      expect(useEditorStore.getState().openFiles.get(path)?.content).toBe('on disk')
    )

    expect(useEditorStore.getState().openFiles.get(path)).toMatchObject({
      isDirty: false,
      externalConflict: false,
      contentHash: 'b'.repeat(64)
    })
  })

  it('Overwrite on the notice saves the buffer WITHOUT a precondition and re-establishes the hash', async () => {
    open(readHash)
    vi.mocked(filesystemApi.writeFile).mockResolvedValueOnce({
      success: false,
      error: 'file changed',
      code: 'PRECONDITION_FAILED'
    })
    await useEditorStore.getState().saveFile(path)
    const [, options] = vi.mocked(toast).mock.calls[0]
    vi.mocked(filesystemApi.writeFile).mockResolvedValue({ success: true, data: undefined })

    options?.cancel && 'onClick' in options.cancel && options.cancel.onClick?.({} as never)
    await vi.waitFor(() => expect(filesystemApi.writeFile).toHaveBeenCalledTimes(2))

    expect(filesystemApi.writeFile).toHaveBeenLastCalledWith(path, 'edited')
    await vi.waitFor(() =>
      expect(useEditorStore.getState().openFiles.get(path)).toMatchObject({
        isDirty: false,
        externalConflict: false,
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
    )
  })

  describe.each([
    'NETWORK_ERROR',
    'OUTCOME_UNKNOWN',
    'COMMAND_IN_PROGRESS'
  ])('a save whose outcome is uncertain (%s)', (code) => {
    const lost = { success: false as const, error: 'lost', code }

    it('is saved when the file read back holds the saved content', async () => {
      open(readHash)
      vi.mocked(filesystemApi.writeFile).mockResolvedValueOnce(lost)
      vi.mocked(filesystemApi.readFile).mockResolvedValueOnce({
        success: true,
        data: { content: 'edited' }
      } as never)

      expect(await useEditorStore.getState().saveFile(path)).toBe(true)

      expect(useEditorStore.getState().openFiles.get(path)).toMatchObject({
        isDirty: false,
        externalConflict: false,
        contentHash: sha256Hex('edited')
      })
    })

    it('keeps the old hash when the file changed, so a retry never overwrites it', async () => {
      open(readHash)
      vi.mocked(filesystemApi.writeFile).mockResolvedValueOnce(lost)
      vi.mocked(filesystemApi.readFile).mockResolvedValueOnce({
        success: true,
        data: { content: 'changed elsewhere' }
      } as never)

      expect(await useEditorStore.getState().saveFile(path)).toBe(false)

      const file = useEditorStore.getState().openFiles.get(path)
      expect(file?.contentHash).toBe(readHash)
      expect(file?.externalConflict).toBeFalsy()
      expect(toast).not.toHaveBeenCalled()
      vi.mocked(filesystemApi.writeFile).mockResolvedValue({ success: true, data: undefined })
      await useEditorStore.getState().saveFile(path)
      expect(filesystemApi.writeFile).toHaveBeenLastCalledWith(path, 'edited', {
        expected: { sha256: readHash }
      })
    })
  })

  it('a file read without a hash (desktop) saves without a precondition', async () => {
    open(undefined)
    vi.mocked(filesystemApi.writeFile).mockResolvedValue({ success: true, data: undefined })

    await useEditorStore.getState().saveFile(path)

    expect(filesystemApi.writeFile).toHaveBeenCalledWith(path, 'edited')
    expect(useEditorStore.getState().openFiles.get(path)?.contentHash).toBeUndefined()
  })
})
