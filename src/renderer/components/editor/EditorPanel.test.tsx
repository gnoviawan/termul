import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { codeEditorProps, markdownEditorProps } = vi.hoisted(() => ({
  codeEditorProps: vi.fn(),
  markdownEditorProps: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  filesystemApi: { readFile: vi.fn(), writeFile: vi.fn() }
}))
vi.mock('@/hooks/use-toc-settings', () => ({ useTocSettings: vi.fn() }))
vi.mock('./CodeEditor', () => ({
  CodeEditor: (props: { readOnly?: boolean }) => {
    codeEditorProps(props)
    return <div data-testid="code-editor" />
  }
}))
vi.mock('./MarkdownEditor', () => ({
  MarkdownEditor: (props: { readOnly?: boolean }) => {
    markdownEditorProps(props)
    return <div data-testid="markdown-editor" />
  }
}))
vi.mock('./EditorToolbar', () => ({ EditorToolbar: () => null }))

import { type EditorFileState, useEditorStore } from '@/stores/editor-store'
import { EditorPanel } from './EditorPanel'

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
          ...overrides
        }
      ]
    ]),
    activeFilePath: FILE
  })
}

beforeEach(() => {
  codeEditorProps.mockClear()
  markdownEditorProps.mockClear()
})

afterEach(() => {
  cleanup()
  useEditorStore.setState({ openFiles: new Map(), activeFilePath: null })
})

describe('EditorPanel draft conflict lock', () => {
  it('keeps the code editor writable when there is no conflict', () => {
    seed()
    render(<EditorPanel filePath={FILE} isVisible />)
    expect(codeEditorProps).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: false }))
  })

  it('makes the code editor read-only while a draft conflict is unresolved', () => {
    seed({ draftConflict: { draftContent: 'draft', draftSavedAt: 1_000 } })
    render(<EditorPanel filePath={FILE} isVisible />)
    expect(codeEditorProps).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true }))
  })

  it('makes the markdown editor read-only while a draft conflict is unresolved', () => {
    seed({
      viewMode: 'preview',
      draftConflict: { draftContent: 'draft', draftSavedAt: 1_000 }
    })
    render(<EditorPanel filePath={FILE} isVisible />)
    expect(markdownEditorProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ readOnly: true })
    )
  })

  it('unlocks the editor once the conflict is resolved', () => {
    seed({ draftConflict: { draftContent: 'draft', draftSavedAt: 1_000 } })
    const { rerender } = render(<EditorPanel filePath={FILE} isVisible />)

    useEditorStore.getState().resolveDraftConflict(FILE, 'disk')
    rerender(<EditorPanel filePath={FILE} isVisible />)

    expect(codeEditorProps).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: false }))
  })
})
