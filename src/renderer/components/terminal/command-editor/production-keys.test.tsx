import type { EditorView } from '@codemirror/view'
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { useWorkspaceKeyboard } from '@/layouts/workspace-layout/use-workspace-keyboard'
import { clipboardApi, terminalApi } from '@/lib/api'
import { commandDraftStore } from '@/lib/command-lifecycle/draft-store'
import { sessionStore } from '@/lib/command-lifecycle/session-store'
import { isMac } from '@/lib/platform'
import { useCommandHistoryStore } from '@/stores/command-history-store'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { isAppOwnedTerminalShortcut } from '../keymap'
import { TerminalInputSurface } from './TerminalInputSurface'
import { useTerminalEditorKeymap } from './use-terminal-editor-keymap'

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

it('production Ctrl+C copies an editor selection without clearing the draft', () => {
  const { view } = mountKeys('kubectl delete pod foo')
  act(() => view.dispatch({ selection: { anchor: 0, head: 7 } }))
  fireEvent.keyDown(view.contentDOM, { key: 'c', ctrlKey: true })
  expect(clipboardApi.writeText).toHaveBeenCalledWith('kubectl')
  expect(view.state.doc.toString()).toBe('kubectl delete pod foo')
  expect(terminalApi.write).not.toHaveBeenCalled()
})

it('production Ctrl+C without selection clears the draft without PTY writes', () => {
  const { view } = mountKeys('clear draft')
  fireEvent.keyDown(view.contentDOM, { key: 'c', ctrlKey: true })
  expect(view.state.doc.toString()).toBe('')
  expect(terminalApi.write).not.toHaveBeenCalled()
})

it('production Ctrl+D keeps the editor usable until the shell actually exits', () => {
  const { view, viewRef } = mountKeys()
  act(() => {
    fireEvent.keyDown(view.contentDOM, { key: 'd', ctrlKey: true })
  })
  expect(sessionStore.read('keys-live').mode).toBe('Editor')
  expect(viewRef.current).toBe(view)
  expect(terminalApi.write).toHaveBeenCalledWith('pty-keys', '\x04')

  act(() => sessionStore.processExited('keys-live'))
  expect(sessionStore.read('keys-live').mode).toBe('exited')
  expect(viewRef.current).toBeNull()
})

it('production Ctrl+D keeps the editor when the EOF write fails', async () => {
  vi.mocked(terminalApi.write).mockRejectedValueOnce(new Error('write failed'))
  const { view, viewRef } = mountKeys()
  act(() => fireEvent.keyDown(view.contentDOM, { key: 'd', ctrlKey: true }))
  await act(async () => Promise.resolve())

  expect(sessionStore.read('keys-live').mode).toBe('Editor')
  expect(viewRef.current).toBe(view)
})

it('blocks PTY and EOF writes after write admission is withdrawn', () => {
  const viewRef: { current: EditorView | null } = { current: null }
  const options = (allowWrite: boolean) => ({
    terminalId: 'keys-live',
    ptyId: () => 'pty-keys',
    allowWrite,
    viewRef
  })
  const { result, rerender } = renderHook(
    ({ allowWrite }: { allowWrite: boolean }) => useTerminalEditorKeymap(options(allowWrite)),
    { initialProps: { allowWrite: true } }
  )

  rerender({ allowWrite: false })
  result.current.writePty?.('ordinary input')
  result.current.sendEof?.()

  expect(terminalApi.write).not.toHaveBeenCalled()
  expect(sessionStore.read('keys-live').mode).toBe('Editor')
})

it('does not send EOF through a stale callback after session trust is invalidated', () => {
  const viewRef: { current: EditorView | null } = { current: null }
  const { result } = renderHook(() =>
    useTerminalEditorKeymap({
      terminalId: 'keys-live',
      ptyId: () => 'pty-keys',
      allowWrite: true,
      viewRef
    })
  )
  sessionStore.invalidate('keys-live')
  result.current.sendEof?.()
  expect(terminalApi.write).not.toHaveBeenCalled()
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

it('production app shortcut reaches the workspace during trusted submission', () => {
  useKeyboardShortcutsStore.getState().setShortcuts({
    commandPalette: {
      id: 'commandPalette',
      label: 'Command Palette',
      description: 'Open command palette',
      defaultKey: 'alt+j',
      customKey: 'ctrl+k'
    }
  })
  expect(sessionStore.beginSubmit('keys-live')).not.toBeNull()
  const { container, opened } = mountKeys('keep draft')
  fireEvent.keyDown(container.querySelector('section')!, {
    key: 'k',
    ctrlKey: !isMac,
    metaKey: isMac
  })
  expect(opened).toEqual(['commandPalette'])
})

it('production nextTerminal shortcut focuses the newly active tab in the same pane', () => {
  const workspace = useWorkspaceStore.getState()
  const previousRoot = workspace.root
  const previousActivePaneId = workspace.activePaneId
  const root = {
    type: 'leaf' as const,
    id: 'keys-pane',
    activeTabId: 'keys-tab-a',
    tabs: [
      { type: 'terminal' as const, id: 'keys-tab-a', terminalId: 'keys-live' },
      { type: 'terminal' as const, id: 'keys-tab-b', terminalId: 'keys-tab-b' }
    ]
  }
  useWorkspaceStore.setState({ root, activePaneId: 'keys-pane' })
  useKeyboardShortcutsStore.getState().setShortcuts({
    nextTerminal: {
      id: 'nextTerminal',
      label: 'Next terminal',
      description: 'Switch to next tab',
      defaultKey: 'alt+j',
      customKey: 'ctrl+pagedown'
    }
  })
  sessionStore.apply('keys-tab-b', { type: 'InitShell', session_id: 's2', nonce: 'n2' })
  sessionStore.apply('keys-tab-b', {
    type: 'PromptReady',
    session_id: 's2',
    nonce: 'n2',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })

  function SplitSurface() {
    const { root: currentRoot } = useWorkspaceStore()
    const activeTabId = currentRoot.type === 'leaf' ? currentRoot.activeTabId : null
    const tab =
      currentRoot.type === 'leaf'
        ? currentRoot.tabs.find((candidate) => candidate.id === activeTabId)
        : undefined
    const sessionA = useSyncExternalStore(sessionStore.subscribe, () =>
      sessionStore.read('keys-live')
    )
    const sessionB = useSyncExternalStore(sessionStore.subscribe, () =>
      sessionStore.read('keys-tab-b')
    )
    useWorkspaceKeyboard({
      activeTab: tab,
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
      setIsCommandPaletteOpen: () => {},
      setIsCommandHistoryOpen: () => {}
    })
    return (
      <div data-pane-content="keys-pane">
        <div data-tab-id="keys-tab-a">
          <TerminalInputSurface
            mode={sessionA.mode}
            focused={activeTabId === 'keys-tab-a'}
            terminalId="keys-live"
          >
            {null}
          </TerminalInputSurface>
        </div>
        <div data-tab-id="keys-tab-b">
          <TerminalInputSurface
            mode={sessionB.mode}
            focused={activeTabId === 'keys-tab-b'}
            terminalId="keys-tab-b"
          >
            {null}
          </TerminalInputSurface>
        </div>
      </div>
    )
  }

  let unmount = () => {}
  try {
    const mounted = render(<SplitSurface />)
    unmount = mounted.unmount
    const editorA = mounted.container.querySelector('[data-tab-id="keys-tab-a"] .cm-content')!
    const editorB = mounted.container.querySelector('[data-tab-id="keys-tab-b"] .cm-content')!
    expect(document.activeElement).toBe(editorA)
    expect(useWorkspaceStore.getState().getNextTabId(1)).toBe('keys-tab-b')

    const shortcutEvent = new KeyboardEvent('keydown', {
      key: 'PageDown',
      ctrlKey: !isMac,
      metaKey: isMac,
      bubbles: true,
      cancelable: true
    })
    expect(
      isAppOwnedTerminalShortcut(shortcutEvent, useKeyboardShortcutsStore.getState().shortcuts)
    ).toBe(true)
    const setActiveTab = vi.spyOn(useWorkspaceStore.getState(), 'setActiveTab')
    fireEvent(editorA, shortcutEvent)

    expect(setActiveTab).toHaveBeenCalledWith('keys-pane', 'keys-tab-b')
    expect(useWorkspaceStore.getState().root).toMatchObject({ activeTabId: 'keys-tab-b' })
    expect(document.activeElement).toBe(editorB)
  } finally {
    unmount()
    useWorkspaceStore.setState({ root: previousRoot, activePaneId: previousActivePaneId })
    sessionStore.forget('keys-tab-b')
    commandDraftStore.processExited('keys-tab-b')
  }
})

it('production view-only surface never mounts an editor or writes EOF', () => {
  const { viewRef, container } = mountKeys('', '', false)
  fireEvent.keyDown(container.querySelector('section')!, { key: 'd', ctrlKey: true })
  expect(viewRef.current).toBeNull()
  expect(terminalApi.write).not.toHaveBeenCalled()
})
