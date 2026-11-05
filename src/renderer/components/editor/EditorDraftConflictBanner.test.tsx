import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
  filesystemApi: { readFile: vi.fn(), writeFile: vi.fn() }
}))

import { type EditorFileState, useEditorStore } from '@/stores/editor-store'
import { EditorDraftConflictBanner } from './EditorDraftConflictBanner'

const FILE = '/project/notes.md'

function seed(overrides: Partial<EditorFileState> = {}): void {
  useEditorStore.setState({
    openFiles: new Map([
      [
        FILE,
        {
          filePath: FILE,
          content: 'disk version',
          kind: 'text',
          originalContent: 'disk version',
          isDirty: false,
          language: 'markdown',
          lastModified: 9_000,
          viewMode: 'code',
          cursorPosition: { line: 1, col: 1 },
          scrollTop: 0,
          operationStatus: 'idle',
          draftConflict: { draftContent: 'my draft', draftSavedAt: 1_000 },
          ...overrides
        }
      ]
    ]),
    activeFilePath: FILE
  })
}

beforeEach(() => {
  seed()
})

afterEach(() => {
  cleanup()
  useEditorStore.setState({ openFiles: new Map(), activeFilePath: null })
})

describe('EditorDraftConflictBanner', () => {
  it('renders nothing when the file has no draft conflict', () => {
    seed({ draftConflict: undefined })
    const { container } = render(<EditorDraftConflictBanner filePath={FILE} />)
    expect(container.firstChild).toBeNull()
  })

  it('explains the conflict and offers both resolutions', () => {
    render(<EditorDraftConflictBanner filePath={FILE} />)

    expect(
      screen.getByText('An unsaved draft differs from the newer file on disk.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep my draft' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use disk version' })).toBeInTheDocument()
  })

  it('Keep my draft applies the draft as an unsaved edit and hides the banner', () => {
    const { container } = render(<EditorDraftConflictBanner filePath={FILE} />)

    fireEvent.click(screen.getByRole('button', { name: 'Keep my draft' }))

    const file = useEditorStore.getState().openFiles.get(FILE)
    expect(file).toMatchObject({ content: 'my draft', isDirty: true })
    expect(file?.draftConflict).toBeUndefined()
    expect(container.firstChild).toBeNull()
  })

  it('Use disk version keeps the disk content and hides the banner', () => {
    const { container } = render(<EditorDraftConflictBanner filePath={FILE} />)

    fireEvent.click(screen.getByRole('button', { name: 'Use disk version' }))

    const file = useEditorStore.getState().openFiles.get(FILE)
    expect(file).toMatchObject({ content: 'disk version', isDirty: false })
    expect(file?.draftConflict).toBeUndefined()
    expect(container.firstChild).toBeNull()
  })
})
