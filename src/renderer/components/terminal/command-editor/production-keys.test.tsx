import type { EditorView } from '@codemirror/view'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { useWorkspaceKeyboard } from '@/layouts/workspace-layout/use-workspace-keyboard'
import { clipboardApi, terminalApi } from '@/lib/api'
import { commandDraftStore } from '@/lib/command-lifecycle/draft-store'
import { sessionStore } from '@/lib/command-lifecycle/session-store'
import { isMac } from '@/lib/platform'
import { useCommandHistoryStore } from '@/stores/command-history-store'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { TerminalInputSurface } from './TerminalInputSurface'

// jsdom has no layout; provide the Range geometry API required by CodeMirror.
const geometryMethods = ['getClientRects', 'getBoundingClientRect'] as const
const originalGeometry = geometryMethods.map((name) =>
  Object.getOwnPropertyDescriptor(Range.prototype, name)
)
beforeAll(() => {
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect()
  })
})
afterAll(() => {
  geometryMethods.forEach((name, index) => {
    const original = originalGeometry[index]
    if (original) Object.defineProperty(Range.prototype, name, original)
    else delete Range.prototype[name]
  })
})

beforeEach(() => {
  sessionStore.apply('keys-live', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  sessionStore.apply('keys-live', {
    type: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
  vi.spyOn(terminalApi, 'write').mockResolvedValue({ success: true })
  vi.spyOn(clipboardApi, 'writeText').mockResolvedValue({ success: true })
  useKeyboardShortcutsStore.getState().setShortcuts({})
})
afterEach(() => {
  cleanup()
  sessionStore.reset()
  commandDraftStore.processExited('keys-live')
  useCommandHistoryStore.getState().setHistory([])
  useKeyboardShortcutsStore.getState().resetAllShortcuts()
  vi.restoreAllMocks()
})

function mountKeys(draft = '', selection = '', allowWrite = true) {
  commandDraftStore.offer('keys-live', 'Editor', draft)
  const viewRef: { current: EditorView | null } = { current: null }
  const opened: string[] = []
  function Surface() {
    const session = useSyncExternalStore(sessionStore.subscribe, () =>
      sessionStore.read('keys-live')
    )
    useWorkspaceKeyboard({
      activeTab: undefined,
      activeProjectId: 'p1',
      projects: [],
      selectProject: () => {},
      isWorkspaceRoute: true,
      isAgentLauncherOpen: false,
      closeActiveTab: () => {},
      getActiveKey: (id) => {
        const shortcut = useKeyboardShortcutsStore.getState().shortcuts[id]
        return shortcut?.customKey ?? shortcut?.defaultKey ?? ''
      },
      handleNewBrowserTab: () => {},
      handleOpenThemePicker: () => {},
      handleOpenAppPreferences: () => {},
      setIsNewProjectModalOpen: () => {},
      setIsCommandPaletteOpen: () => opened.push('commandPalette'),
      setIsCommandHistoryOpen: () => opened.push('commandHistory')
    })
    return (
      <TerminalInputSurface
        terminalId="keys-live"
        projectId="p1"
        ptyId={() => 'pty-keys'}
        mode={session.mode}
        focused={false}
        viewRef={viewRef}
        allowWrite={allowWrite}
        keymapDeps={selection ? { selection: () => selection } : undefined}
      >
        <div />
      </TerminalInputSurface>
    )
  }
  const mounted = render(<Surface />)
  return { ...mounted, view: viewRef.current!, viewRef, opened }
}

it('production Up recalls newest project history before older entries', () => {
  const store = useCommandHistoryStore.getState()
  const entry = { terminalId: 'other-pane', terminalName: 'Shell', projectId: 'p1', timestamp: 1 }
  store.addCommand({ ...entry, command: 'older' })
  store.addCommand({ ...entry, command: 'newest', timestamp: 2 })
  store.addCommand({ ...entry, projectId: 'p2', command: 'foreign', timestamp: 3 })
  const { view } = mountKeys()
  fireEvent.keyDown(view.contentDOM, { key: 'ArrowUp' })
  expect(view.state.doc.toString()).toBe('newest')
  fireEvent.keyDown(view.contentDOM, { key: 'ArrowUp' })
  expect(view.state.doc.toString()).toBe('older')
})

it('production Ctrl+C copies xterm selection and preserves the draft', () => {
  const { view } = mountKeys('keep draft', 'selected output')
  fireEvent.keyDown(view.contentDOM, { key: 'c', ctrlKey: true })
  expect(clipboardApi.writeText).toHaveBeenCalledWith('selected output')
  expect(view.state.doc.toString()).toBe('keep draft')
  expect(terminalApi.write).not.toHaveBeenCalled()
})

it('production Ctrl+C without selection clears the draft without PTY writes', () => {
  const { view } = mountKeys('clear draft')
  fireEvent.keyDown(view.contentDOM, { key: 'c', ctrlKey: true })
  expect(view.state.doc.toString()).toBe('')
  expect(terminalApi.write).not.toHaveBeenCalled()
})

it('production Ctrl+D leaves an empty editor and sends EOF', () => {
  const { view, viewRef } = mountKeys()
  act(() => {
    fireEvent.keyDown(view.contentDOM, { key: 'd', ctrlKey: true })
  })
  expect(sessionStore.read('keys-live').mode).toBe('PTY')
  expect(viewRef.current).toBeNull()
  expect(terminalApi.write).toHaveBeenCalledWith('pty-keys', '\x04')
})

it('production Ctrl+D at the end of a draft keeps the draft without EOF', () => {
  const { view } = mountKeys('keep draft')
  act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }))
  fireEvent.keyDown(view.contentDOM, { key: 'd', ctrlKey: true })
  expect(view.state.doc.toString()).toBe('keep draft')
  expect(terminalApi.write).not.toHaveBeenCalled()
})

it.each([
  ['commandPalette', 'k'],
  ['commandHistory', 'u']
])('production configured %s shortcut reaches the workspace handler once', (id, key) => {
  useKeyboardShortcutsStore.getState().setShortcuts({
    [id]: { id, label: id, description: id, defaultKey: 'alt+j', customKey: `ctrl+${key}` }
  })
  const { view, opened } = mountKeys('keep draft')
  fireEvent.keyDown(view.contentDOM, { key, ctrlKey: !isMac, metaKey: isMac })
  expect(opened).toEqual([id])
  expect(view.state.doc.toString()).toBe('keep draft')
})

it('production view-only surface never mounts an editor or writes EOF', () => {
  const { viewRef, container } = mountKeys('', '', false)
  fireEvent.keyDown(container.querySelector('section')!, { key: 'd', ctrlKey: true })
  expect(viewRef.current).toBeNull()
  expect(terminalApi.write).not.toHaveBeenCalled()
})
