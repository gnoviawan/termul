import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getFileInfo: vi.fn(),
  openFile: vi.fn(),
  updateCursorPosition: vi.fn(),
  addEditorTab: vi.fn(),
  toastError: vi.fn(),
  openFiles: new Map<string, unknown>()
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    filesystemApi: { ...actual.filesystemApi, getFileInfo: mocks.getFileInfo }
  }
})

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: {
    getState: () => ({
      openFiles: mocks.openFiles,
      openFile: mocks.openFile,
      updateCursorPosition: mocks.updateCursorPosition
    })
  }
}))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: { getState: () => ({ addEditorTab: mocks.addEditorTab }) }
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(() => Promise.resolve()) }))

import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentProse } from './chat-agent-prose'

function renderChat(text: string): HTMLElement {
  const { container } = render(
    <TooltipProvider>
      <AgentProse text={text} streaming={false} reduced filePathContext={{ cwd: '/repo' }} />
    </TooltipProvider>
  )
  return container
}

describe('agent prose path links with #L line fragments', () => {
  beforeEach(() => {
    mocks.getFileInfo.mockReset().mockImplementation(async (path: string) => ({
      success: true,
      data: { path, size: 1, modifiedAt: 1, type: 'file', isReadOnly: false, isBinary: false }
    }))
    mocks.openFile.mockReset().mockImplementation(async (path: string) => {
      mocks.openFiles.set(path, { kind: 'text' })
    })
    mocks.updateCursorPosition.mockReset()
    mocks.addEditorTab.mockReset()
    mocks.toastError.mockReset()
    mocks.openFiles.clear()
  })

  it.each([
    ['See src/x.ts#L10 for the bug.', 'src/x.ts#L10', '/repo/src/x.ts', 10],
    ['See src/x.ts#L10-L20 for the bug.', 'src/x.ts#L10-L20', '/repo/src/x.ts', 10],
    ['See [the bug](src/x.ts#L10).', 'the bug', '/repo/src/x.ts', 10]
  ])('%s opens %s at %s line %s', async (markdown, label, target, line) => {
    const container = renderChat(markdown)

    const button = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('button[data-testid="termul-file-path"]')
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    expect(button).toHaveTextContent(label)
    fireEvent.click(button)

    await waitFor(() => expect(mocks.addEditorTab).toHaveBeenCalledWith(target))
    expect(mocks.getFileInfo).toHaveBeenCalledWith(target)
    expect(mocks.openFile).toHaveBeenCalledWith(target)
    expect(mocks.updateCursorPosition).toHaveBeenCalledWith(target, line, 1)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it.each([
    'Run main.rs now.',
    'See owner/repo#L10 upstream.',
    'Pick one, e.g. the first.',
    'Edit `main.rs` next.',
    'Edit `src/x.ts#L10` next.'
  ])('leaves %s unlinked', async (markdown) => {
    const container = renderChat(markdown)

    await waitFor(() => expect(container.textContent).not.toBe(''))
    expect(container.querySelector('[data-testid="termul-file-path"]')).toBeNull()
  })
})
