import { SearchQuery, searchPanelOpen } from '@codemirror/search'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, runScopeHandlers } from '@codemirror/view'
import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { logFrontendError } = vi.hoisted(() => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/log-api', () => ({ logFrontendError }))

import {
  collectMatches,
  editorFind,
  editorFindKeymap,
  MATCH_LIMIT,
  matchIndex,
  resolveGoToLine
} from './codemirror-find'

const editors: Array<{ view: EditorView; parent: HTMLElement }> = []

/** A real EditorView attached to the document, as focus and panel mounting need. */
function createEditor(doc: string, readOnly = false): EditorView {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [editorFind(), keymap.of(editorFindKeymap), EditorState.readOnly.of(readOnly)]
    })
  })
  editors.push({ view, parent })
  return view
}

/** A key pressed with the editor focused. */
function press(view: EditorView, key: string, init: KeyboardEventInit = {}): boolean {
  let handled = false
  act(() => {
    handled = runScopeHandlers(view, new KeyboardEvent('keydown', { key, ...init }), 'editor')
  })
  return handled
}

/** Ctrl+F in the editor, then optionally type a query into the find field. */
function openFind(view: EditorView, query?: string): void {
  press(view, 'f', { ctrlKey: true })
  if (query !== undefined) fireEvent.change(findField(), { target: { value: query } })
}

/** The widget's fields, looked up fresh because the panel re-renders. */
const findField = () => screen.getByRole('textbox', { name: 'Find' })
const replaceField = () => screen.getByRole('textbox', { name: 'Replace' })

afterEach(async () => {
  for (const { view, parent } of editors.splice(0)) {
    act(() => view.destroy())
    parent.remove()
  }
  // Panel roots unmount on a microtask.
  await act(async () => {})
  vi.clearAllMocks()
})

describe('editor find widget', () => {
  it('opens on Ctrl+F with the find field focused', () => {
    const view = createEditor('one foo\ntwo foo')
    expect(press(view, 'f', { ctrlKey: true })).toBe(true)
    expect(searchPanelOpen(view.state)).toBe(true)
    expect(document.activeElement).toBe(findField())
  })

  it('selects the next match as you type and counts the matches', () => {
    const view = createEditor('one foo\ntwo foo\nthree foo')
    openFind(view, 'foo')
    expect(view.state.selection.main).toMatchObject({ from: 4, to: 7 })
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
  })

  it('moves between matches on Enter and Shift+Enter and keeps the caret', () => {
    const view = createEditor('one foo\ntwo foo\nthree foo')
    openFind(view, 'foo')
    findField().setSelectionRange(1, 1)

    fireEvent.keyDown(findField(), { key: 'Enter' })
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
    expect(view.state.selection.main).toMatchObject({ from: 12, to: 15 })
    expect(findField()).toHaveProperty('selectionStart', 1)
    expect(findField()).toHaveProperty('selectionEnd', 1)

    fireEvent.keyDown(findField(), { key: 'Enter', shiftKey: true })
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
  })

  it('seeds the query from the selection on Ctrl+F', () => {
    const view = createEditor('alpha beta alpha')
    act(() => view.dispatch({ selection: { anchor: 6, head: 10 } }))
    openFind(view)
    expect(findField()).toHaveValue('beta')
    expect(screen.getByText('1 of 1')).toBeInTheDocument()
  })

  it('matches case after Alt+C', () => {
    const view = createEditor('Foo foo')
    openFind(view, 'foo')
    expect(screen.getByText('1 of 2')).toBeInTheDocument()

    fireEvent.keyDown(findField(), { key: 'c', code: 'KeyC', altKey: true })
    expect(screen.getByRole('button', { name: 'Match case' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(view.state.selection.main).toMatchObject({ from: 4, to: 7 })
    expect(screen.getByText('1 of 1')).toBeInTheDocument()
  })

  it('reports an invalid regular expression', () => {
    const view = createEditor('a (b) c')
    openFind(view)
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }))
    fireEvent.change(findField(), { target: { value: '(' } })
    expect(screen.getByText('Invalid regex')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled()
  })

  it('opens replace on Ctrl+H, replaces on Enter and replaces all on Ctrl+Alt+Enter', () => {
    const view = createEditor('foo foo foo')
    openFind(view, 'foo')

    fireEvent.keyDown(findField(), { key: 'h', ctrlKey: true })
    expect(document.activeElement).toBe(replaceField())

    fireEvent.change(replaceField(), { target: { value: 'bar' } })
    fireEvent.keyDown(replaceField(), { key: 'Enter' })
    expect(view.state.doc.toString()).toBe('bar foo foo')

    fireEvent.keyDown(replaceField(), { key: 'Enter', ctrlKey: true, altKey: true })
    expect(view.state.doc.toString()).toBe('bar bar bar')
    expect(logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info', source: 'editor-find' })
    )
  })

  it('closes on Escape and hands focus back to the editor', () => {
    const view = createEditor('one foo')
    openFind(view, 'foo')
    fireEvent.keyDown(findField(), { key: 'Escape' })
    expect(searchPanelOpen(view.state)).toBe(false)
    expect(screen.queryByRole('search', { name: 'Find' })).toBeNull()
    expect(view.hasFocus).toBe(true)
  })

  it('has no replace in a read-only editor', () => {
    const view = createEditor('foo', true)
    expect(press(view, 'h', { ctrlKey: true })).toBe(true)
    expect(searchPanelOpen(view.state)).toBe(true)
    expect(screen.queryByRole('button', { name: 'Toggle replace' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Replace' })).toBeNull()
  })
})

describe('editor go to line', () => {
  const goToLineField = () => screen.getByRole('textbox', { name: 'Go to line' })

  it('jumps to the line entered on Ctrl+G', () => {
    const view = createEditor('a\nb\nc\nd')
    expect(press(view, 'g', { ctrlKey: true })).toBe(true)
    expect(document.activeElement).toBe(goToLineField())

    fireEvent.change(goToLineField(), { target: { value: '3' } })
    fireEvent.keyDown(goToLineField(), { key: 'Enter' })
    expect(view.state.selection.main.head).toBe(4)
    expect(screen.queryByRole('dialog', { name: 'Go to line' })).toBeNull()
    expect(view.hasFocus).toBe(true)
  })

  it('stays open on an entry that is not a line, and Escape closes it', () => {
    const view = createEditor('a\nb')
    press(view, 'g', { ctrlKey: true })
    fireEvent.change(goToLineField(), { target: { value: 'abc' } })
    fireEvent.keyDown(goToLineField(), { key: 'Enter' })
    expect(goToLineField()).toHaveAttribute('aria-invalid', 'true')
    expect(goToLineField()).toHaveAccessibleDescription('Lines 1–2')

    fireEvent.keyDown(goToLineField(), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Go to line' })).toBeNull()
    expect(view.hasFocus).toBe(true)
  })

  it('ignores the Safari composition-confirming Enter (keyCode 229)', () => {
    const view = createEditor('a\nb\nc')
    press(view, 'g', { ctrlKey: true })
    fireEvent.change(goToLineField(), { target: { value: '3' } })
    fireEvent.keyDown(goToLineField(), { key: 'Enter', keyCode: 229, isComposing: false })
    expect(view.state.selection.main.head).toBe(0)
    expect(goToLineField()).toBeInTheDocument()
  })
})

describe('resolveGoToLine', () => {
  const doc = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n')
  const base = EditorState.create({ doc })
  // Cursor on line 5.
  const state = base.update({ selection: { anchor: base.doc.line(5).from } }).state
  const lineStart = (line: number) => state.doc.line(line).from

  it.each([
    ['3', lineStart(3)],
    ['3:4', lineStart(3) + 3],
    ['3:999', state.doc.line(3).to],
    [':2', lineStart(5) + 1],
    ['+2', lineStart(7)],
    ['-10', lineStart(1)],
    ['99', lineStart(10)],
    ['50%', lineStart(5)],
    [' 4 ', lineStart(4)]
  ])('resolves "%s"', (input, position) => {
    expect(resolveGoToLine(state, input)).toBe(position)
  })

  it.each(['', '+', 'abc', '1:2:3'])('rejects "%s"', (input) => {
    expect(resolveGoToLine(state, input)).toBeNull()
  })
})

describe('collectMatches', () => {
  it(`stops counting at ${MATCH_LIMIT}`, () => {
    const state = EditorState.create({ doc: 'a '.repeat(MATCH_LIMIT + 5) })
    const { ranges, capped } = collectMatches(state, new SearchQuery({ search: 'a' }))
    expect(ranges).toHaveLength(MATCH_LIMIT)
    expect(capped).toBe(true)
    expect(matchIndex(ranges, 2, 3)).toBe(2)
    expect(matchIndex(ranges, 1, 2)).toBe(0)
  })

  it('skips empty regular expression matches', () => {
    const state = EditorState.create({ doc: 'abc' })
    const query = new SearchQuery({ search: 'x*', regexp: true })
    expect(collectMatches(state, query).ranges).toEqual([])
  })
})
