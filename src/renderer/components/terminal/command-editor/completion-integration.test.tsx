import { completionStatus } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const { FakeSocket } = vi.hoisted(() => {
  class FakeSocket {
    static OPEN = 1
    static CONNECTING = 0
    static instances: FakeSocket[] = []
    readyState = 0
    onopen: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    sent: string[] = []
    constructor() {
      FakeSocket.instances.push(this)
      queueMicrotask(() => {
        this.readyState = 1
        this.onopen?.(new Event('open'))
      })
    }
    send(raw: string) {
      this.sent.push(raw)
      const frame = JSON.parse(raw) as { id: string; type: string }
      if (frame.type === 'authenticate') this.reply(frame.id, {})
      if (frame.type === 'list_preserved') this.reply(frame.id, { projectId: 'p1', terminals: [] })
      if (frame.type === 'command_editor_cancel_completion') this.reply(frame.id, 'Accepted')
    }
    reply(id: string, data: unknown) {
      this.onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({ id, success: true, data })
        })
      )
    }
    close() {
      this.readyState = 3
    }
  }
  vi.stubGlobal('WebSocket', FakeSocket)
  return { FakeSocket }
})

import { useSyncExternalStore } from 'react'
import { terminalApi } from '@/lib/api'
import { bindSessionClient } from '@/lib/command-lifecycle/bind-session'
import { CompletionScheduler } from '@/lib/command-lifecycle/completion'
import { commandDraftStore } from '@/lib/command-lifecycle/draft-store'
import { readEditorRevision } from '@/lib/command-lifecycle/editor-revision'
import { sessionStore } from '@/lib/command-lifecycle/session-store'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { CommandEditor } from './CommandEditor'
import { ghostText } from './completion-view'
import { routeForeignInsert } from './foreign-insert'
import { TerminalInputSurface } from './TerminalInputSurface'

beforeAll(async () => {
  await terminalApi.listPreserved('p1')
})
beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.instances[0].sent.length = 0
  useAppSettingsStore.getState().updateSetting('automaticCompletionRefresh', true)
  sessionStore.apply('completion-live', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  sessionStore.apply('completion-live', {
    type: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
})
afterEach(() => {
  cleanup()
  sessionStore.reset()
  commandDraftStore.processExited('completion-live')
  vi.useRealTimers()
})

function mountProductionEditor(edit = true) {
  const viewRef: { current: EditorView | null } = { current: null }
  function Surface() {
    const session = useSyncExternalStore(sessionStore.subscribe, () =>
      sessionStore.read('completion-live')
    )
    return (
      <TerminalInputSurface
        terminalId="completion-live"
        mode={session.mode}
        focused={false}
        ptyId={() => 'pty-9'}
        viewRef={viewRef}
      >
        <div />
      </TerminalInputSurface>
    )
  }
  const mounted = render(<Surface />)
  const view = viewRef.current!
  if (edit)
    act(() =>
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: 'git st' },
        selection: { anchor: 6 },
        userEvent: 'input.type'
      })
    )
  return { ...mounted, view, viewRef }
}

function completionFrames() {
  return FakeSocket.instances[0].sent
    .map(
      (raw) =>
        JSON.parse(raw) as {
          id: string
          type: string
          payload: {
            requestId: string
            bufferRevision: number
            cursor: number
            promptGeneration: number
            cwd: string
          }
        }
    )
    .filter((frame) => frame.type === 'command_editor_request_completion')
}

async function replyWithRows() {
  const request = completionFrames()[0]
  expect(request).toBeDefined()
  FakeSocket.instances[0].reply(request.id, {
    result: 'Accepted',
    outcome: 'Completed',
    completion: {
      request_id: request.payload.requestId,
      buffer_revision: request.payload.bufferRevision,
      cursor: request.payload.cursor,
      prompt_generation: request.payload.promptGeneration,
      cwd: request.payload.cwd,
      output: '737461747573\n737461747573202d2d73686f7274'
    }
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(80)
  })
}

it('tab requests completion with refresh off', async () => {
  useAppSettingsStore.getState().updateSetting('automaticCompletionRefresh', false)
  const { view } = mountProductionEditor()
  fireEvent.keyDown(view.contentDOM, { key: 'Tab' })
  expect(completionFrames()).toHaveLength(1)
  expect(FakeSocket.instances[0].sent.some((raw) => JSON.parse(raw).type === 'write')).toBe(false)
})

it('valid result shows ghost and dropdown', async () => {
  const { view, container } = mountProductionEditor()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  await replyWithRows()
  expect(completionStatus(view.state)).toBe('active')
  expect(container.querySelector('[role="listbox"]')).toBeTruthy()
  expect(ghostText(view.state)).toBe('atus')
})

it('idle edit with refresh on shows the result', async () => {
  const { view } = mountProductionEditor()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(completionFrames()).toHaveLength(1)
  await replyWithRows()
  expect(ghostText(view.state)).toBe('atus')
})

it('stale result for an old revision is not shown', async () => {
  const { view } = mountProductionEditor()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  act(() =>
    view.dispatch({
      changes: { from: 6, insert: 'a' },
      selection: { anchor: 7 },
      userEvent: 'input.type'
    })
  )
  await replyWithRows()
  expect(completionStatus(view.state)).not.toBe('active')
  expect(ghostText(view.state)).toBeNull()
})

it('accept edits the document only', async () => {
  const { view } = mountProductionEditor()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  await replyWithRows()
  expect(completionStatus(view.state)).toBe('active')
  const previous = [...FakeSocket.instances[0].sent]
  fireEvent.keyDown(view.contentDOM, { key: 'Tab' })
  expect(view.state.doc.toString()).toBe('git status')
  expect(FakeSocket.instances[0].sent).toEqual(previous)
})

it('no rpc after unmount', async () => {
  const mounted = mountProductionEditor()
  mounted.unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150)
  })
  expect(completionFrames()).toHaveLength(0)
})

it('no rpc after process exit', async () => {
  mountProductionEditor()
  act(() => {
    sessionStore.processExited('completion-live')
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150)
  })
  expect(completionFrames()).toHaveLength(0)
})

it('no rpc after desync', async () => {
  mountProductionEditor()
  act(() => {
    sessionStore.apply('completion-live', { type: 'Desync', session_id: 's1', nonce: 'n1' })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150)
  })
  expect(completionFrames()).toHaveLength(0)
})

it('revision survives remount', async () => {
  const first = mountProductionEditor()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  const revision = completionFrames()[0].payload.bufferRevision
  first.unmount()
  mountProductionEditor()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(completionFrames().at(-1)?.payload.bufferRevision).toBe(revision + 1)
})

it('exit releases the revision entry', async () => {
  const first = mountProductionEditor()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  first.unmount()
  sessionStore.processExited('completion-live')
  sessionStore.apply('completion-live', { type: 'InitShell', session_id: 's2', nonce: 'n2' })
  sessionStore.apply('completion-live', {
    type: 'PromptReady',
    session_id: 's2',
    nonce: 'n2',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
  mountProductionEditor()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(completionFrames().at(-1)?.payload.bufferRevision).toBe(1)
})

const inputContext = {
  draft: 'git st',
  cursor: 6,
  revision: 1,
  sessionId: 'forged',
  mode: 'Editor' as const,
  phase: 'AtPrompt' as const,
  promptGeneration: 99,
  cwd: '/untrusted'
}

it('result after session change is dropped', async () => {
  const binder = bindSessionClient({
    host: terminalApi,
    terminalId: 'completion-live',
    ptyId: () => 'pty-9'
  })
  binder.requestCompletion(inputContext)
  sessionStore.apply('completion-live', { type: 'InitShell', session_id: 's2', nonce: 'n2' })
  await replyWithRows()
  expect(binder.completion()).toBeNull()
})

it('scheduler methods stay unpatched', () => {
  const scheduler = new CompletionScheduler({
    host: terminalApi,
    createRequestId: () => 'unpatched',
    settings: { automaticCompletionRefresh: false }
  })
  const update = scheduler.updateContext
  const request = scheduler.requestCompletion
  bindSessionClient({
    host: terminalApi,
    terminalId: 'completion-live',
    ptyId: () => 'pty-9',
    scheduler
  })
  expect(scheduler.updateContext).toBe(update)
  expect(scheduler.requestCompletion).toBe(request)
})

it('incomplete prompt context skips completion', async () => {
  sessionStore.reset()
  const binder = bindSessionClient({
    host: terminalApi,
    terminalId: 'completion-live',
    ptyId: () => 'pty-9'
  })
  binder.requestCompletion(inputContext)
  sessionStore.apply('completion-live', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  binder.updateContext(inputContext)
  await vi.advanceTimersByTimeAsync(100)
  binder.requestCompletion(inputContext)
  expect(completionFrames()).toHaveLength(0)
})

function submitFrames() {
  return FakeSocket.instances[0].sent
    .map((raw) => JSON.parse(raw) as { id: string; type: string })
    .filter((frame) => frame.type === 'command_editor_submit')
}

async function acceptSubmit() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const frame = submitFrames()[0]
    expect(frame).toBeDefined()
    FakeSocket.instances[0].reply(frame.id, 'Accepted')
  })
}

it('enter removes the production composer while rpc is pending', async () => {
  const { view, viewRef } = mountProductionEditor()
  fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
  expect(sessionStore.read('completion-live').phase).toBe('Submitting')
  expect(viewRef.current).toBeNull()
  await acceptSubmit()
})

it('submitting keymap discards edits and repeated enter', async () => {
  const viewRef: { current: EditorView | null } = { current: null }
  render(
    <CommandEditor
      terminalId="completion-live"
      focused={false}
      viewRef={viewRef}
      ptyId={() => 'pty-9'}
    />
  )
  const view = viewRef.current!
  act(() =>
    view.dispatch({
      changes: { from: 0, insert: 'git st' },
      selection: { anchor: 6 },
      userEvent: 'input.type'
    })
  )
  fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
  fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
  act(() => view.dispatch({ changes: { from: 6, insert: 'extra' }, userEvent: 'input.type' }))
  expect(view.state.doc.toString()).toBe('git st')
  expect(commandDraftStore.read('completion-live')).toBe('git st')
  await acceptSubmit()
  expect(submitFrames()).toHaveLength(1)
  expect(FakeSocket.instances[0].sent.some((raw) => JSON.parse(raw).type === 'write')).toBe(false)
})

it('tab after remount keeps the current revision', async () => {
  const first = mountProductionEditor()
  act(() =>
    first.view.dispatch({
      changes: { from: 0, to: 6, insert: '' },
      selection: { anchor: 0 },
      userEvent: 'input.type'
    })
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(completionFrames()).toHaveLength(0)
  const revision = readEditorRevision('completion-live')
  first.unmount()
  FakeSocket.instances[0].sent.length = 0
  useAppSettingsStore.getState().updateSetting('automaticCompletionRefresh', false)
  const second = mountProductionEditor(false)
  fireEvent.keyDown(second.view.contentDOM, { key: 'Tab' })
  expect(completionFrames()[0].payload.bufferRevision).toBe(revision)
  await replyWithRows()
  expect(ghostText(second.view.state)).toBe('status')
})

it('submitting window discards terminal keys and paste', async () => {
  const { view, container } = mountProductionEditor()
  fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
  const terminal = container.querySelector('section')!
  expect(fireEvent.keyDown(terminal, { key: 'x', cancelable: true })).toBe(false)
  expect(fireEvent.paste(terminal, { cancelable: true })).toBe(false)
  expect(fireEvent.input(terminal, { data: 'x', cancelable: true })).toBe(false)
  await acceptSubmit()
})

it('desync releases terminal input during a pending submit', async () => {
  const { view, container } = mountProductionEditor()
  fireEvent.keyDown(view.contentDOM, { key: 'Enter' })
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
  act(() => {
    sessionStore.apply('completion-live', { type: 'Desync', session_id: 's1', nonce: 'n1' })
  })
  expect(
    fireEvent.keyDown(container.querySelector('section')!, { key: 'x', cancelable: true })
  ).toBe(true)
  await acceptSubmit()
})

it('immediate Tab completes a restored draft at its end and shows the result', async () => {
  useAppSettingsStore.getState().updateSetting('automaticCompletionRefresh', false)
  commandDraftStore.offer('completion-live', 'Editor', 'git sta')
  const { view } = mountProductionEditor(false)
  fireEvent.keyDown(view.contentDOM, { key: 'Tab' })
  expect(completionFrames()[0]?.payload).toMatchObject({ draft: 'git sta', cursor: 7 })
  await replyWithRows()
  expect(ghostText(view.state)).toBe('tus')
})

it('immediate Tab completes a foreign insert retained before mount', () => {
  useAppSettingsStore.getState().updateSetting('automaticCompletionRefresh', false)
  routeForeignInsert(
    {
      terminalId: 'completion-live',
      ptyId: () => 'pty-9',
      mode: () => 'Editor',
      view: () => null,
      allowWrite: () => true,
      scrollPages: () => {}
    },
    'history',
    'git sta',
    () => {
      throw new Error('Unexpected PTY write')
    }
  )
  const { view } = mountProductionEditor(false)
  fireEvent.keyDown(view.contentDOM, { key: 'Tab' })
  expect(completionFrames()[0]?.payload).toMatchObject({ draft: 'git sta', cursor: 7 })
})

it('immediate Tab completes a live foreign insert', () => {
  useAppSettingsStore.getState().updateSetting('automaticCompletionRefresh', false)
  const { view } = mountProductionEditor(false)
  act(() =>
    routeForeignInsert(
      {
        terminalId: 'completion-live',
        ptyId: () => 'pty-9',
        mode: () => 'Editor',
        view: () => view,
        allowWrite: () => true,
        scrollPages: () => {}
      },
      'history',
      'git sta',
      () => {
        throw new Error('Unexpected PTY write')
      }
    )
  )
  fireEvent.keyDown(view.contentDOM, { key: 'Tab' })
  expect(completionFrames()[0]?.payload).toMatchObject({ draft: 'git sta', cursor: 7 })
})

it('deleting all text hides picker, ghost text, and does not request completion', async () => {
  const { view, container } = mountProductionEditor()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })
  await replyWithRows()
  expect(container.querySelector('.cm-tooltip-autocomplete')).toBeTruthy()
  expect(container.querySelector('.cm-completion-ghost')).toBeTruthy()
  expect(completionFrames()).toHaveLength(1)

  act(() =>
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: '' },
      selection: { anchor: 0 },
      userEvent: 'input.type'
    })
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100)
  })

  expect(container.querySelector('.cm-tooltip-autocomplete')).toBeNull()
  expect(container.querySelector('.cm-completion-ghost')).toBeNull()
  expect(completionFrames()).toHaveLength(1)
})
