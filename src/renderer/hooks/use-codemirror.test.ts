import { searchPanelOpen } from '@codemirror/search'
import { runScopeHandlers } from '@codemirror/view'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { requestSaveEditorFile } = vi.hoisted(() => ({ requestSaveEditorFile: vi.fn() }))
vi.mock('@/lib/editor-save', () => ({ requestSaveEditorFile }))

import { useCodeMirror } from './use-codemirror'

const containers: HTMLDivElement[] = []

function renderEditor(onSave?: (content: string) => void) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  const onChange = vi.fn()
  // One ref for the whole test: a new ref object per render would re-run the
  // editor's setup effect and destroy the view on every re-render.
  const containerRef = { current: container }
  const hook = renderHook(() =>
    useCodeMirror(containerRef, {
      filePath: '/remote/a.txt',
      content: 'hello',
      language: 'text',
      onChange,
      onCursorChange: vi.fn(),
      onScrollChange: vi.fn(),
      onSave
    })
  )
  return { ...hook, onChange }
}

function pressModS(view: NonNullable<ReturnType<typeof useCodeMirror>['view']>) {
  // jsdom is not a Mac, so Mod is Ctrl.
  const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true })
  return runScopeHandlers(view, event, 'editor')
}

afterEach(() => {
  vi.clearAllMocks()
  for (const container of containers.splice(0)) container.remove()
})

describe('useCodeMirror Mod-s', () => {
  it('hands onSave the text on screen, even before the debounced onChange', async () => {
    const onSave = vi.fn()
    const { result, onChange } = renderEditor(onSave)
    await waitFor(() => expect(result.current.view).not.toBeNull(), { timeout: 5000 })
    const view = result.current.view!
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' world' } })

    expect(pressModS(view)).toBe(true)
    expect(onSave).toHaveBeenCalledWith('hello world')
    expect(onChange).not.toHaveBeenCalled()
    expect(requestSaveEditorFile).not.toHaveBeenCalled()
  })

  it('saves through the editor store without onSave', async () => {
    const { result } = renderEditor()
    await waitFor(() => expect(result.current.view).not.toBeNull(), { timeout: 5000 })

    expect(pressModS(result.current.view!)).toBe(true)
    expect(requestSaveEditorFile).toHaveBeenCalledWith('/remote/a.txt')
  })
})

describe('useCodeMirror find', () => {
  /** Ctrl+key with the editor focused, inside act because the find panels render React. */
  function pressCtrl(view: NonNullable<ReturnType<typeof useCodeMirror>['view']>, key: string) {
    const event = new KeyboardEvent('keydown', { key, ctrlKey: true })
    let handled = false
    act(() => {
      handled = runScopeHandlers(view, event, 'editor')
    })
    return handled
  }

  it('opens the find widget on Ctrl+F', async () => {
    const { result } = renderEditor()
    await waitFor(() => expect(result.current.view).not.toBeNull(), { timeout: 5000 })
    const view = result.current.view!

    expect(pressCtrl(view, 'f')).toBe(true)
    expect(searchPanelOpen(view.state)).toBe(true)
    expect(document.activeElement).toBe(view.dom.querySelector('[data-find-field="search"]'))
  })

  it('opens the find widget with the replace field focused on Ctrl+H', async () => {
    const { result } = renderEditor()
    await waitFor(() => expect(result.current.view).not.toBeNull(), { timeout: 5000 })
    const view = result.current.view!

    expect(pressCtrl(view, 'h')).toBe(true)
    expect(searchPanelOpen(view.state)).toBe(true)
    expect(document.activeElement).toBe(view.dom.querySelector('[data-find-field="replace"]'))
  })

  it('opens go to line on Ctrl+G', async () => {
    const { result } = renderEditor()
    await waitFor(() => expect(result.current.view).not.toBeNull(), { timeout: 5000 })
    const view = result.current.view!

    expect(pressCtrl(view, 'g')).toBe(true)
    expect(document.activeElement).toBe(view.dom.querySelector('[data-go-to-line]'))
    expect(searchPanelOpen(view.state)).toBe(false)
  })
})
