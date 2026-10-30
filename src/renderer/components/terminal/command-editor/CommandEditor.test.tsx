import { readFileSync } from 'node:fs'
import { completionStatus, startCompletion } from '@codemirror/autocomplete'
import { type EditorView, runScopeHandlers } from '@codemirror/view'
import type {
  CompletionReplyFields,
  CompletionRpcReply,
  TerminalApi
} from '@shared/types/ipc.types'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { CompletionScheduler } from '@/lib/command-lifecycle/completion'
import { createCommandDraftStore } from '@/lib/command-lifecycle/draft-store'
import { sessionStore } from '@/lib/command-lifecycle/session-store'
import { CommandEditor } from './CommandEditor'
import { ghostText } from './completion-view'

afterEach(() => {
  cleanup()
  sessionStore.reset()
})

it('editor installs the completion extension', async () => {
  const viewRef: { current: EditorView | null } = { current: null }
  const draftStore = createCommandDraftStore()
  draftStore.offer('completion-editor', 'Editor', 'git re')
  const submitted: string[] = []
  let sourceReads = 0
  const source = {
    rows: () => {
      sourceReads++
      return [{ text: 'remote', from: 4, to: 7 }]
    },
    request: () => {
      throw new Error('The extension must not request on typing or open')
    }
  }
  const props = {
    terminalId: 'completion-editor',
    focused: false,
    viewRef,
    draftStore,
    keymapDeps: { history: () => [], submit: (text: string) => submitted.push(text) }
  }
  const { rerender } = render(<CommandEditor {...props} />)
  const view = viewRef.current!
  expect(startCompletion(view)).toBe(true)
  await waitFor(() => expect(completionStatus(view.state)).toBeNull())

  rerender(<CommandEditor {...props} completionSource={source} />)
  expect(viewRef.current).toBe(view)
  act(() =>
    view.dispatch({
      changes: { from: 6, insert: 'm' },
      selection: { anchor: 7 },
      userEvent: 'input.type'
    })
  )
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(completionStatus(view.state)).toBeNull()
  expect(sourceReads).toBe(0)

  act(() => {
    startCompletion(view)
  })
  await waitFor(() => expect(completionStatus(view.state)).toBe('active'))
  expect(sourceReads).toBeGreaterThan(0)
  runScopeHandlers(view, new KeyboardEvent('keydown', { key: 'Enter' }), 'editor')
  expect(submitted).toEqual(['git rem'])
  expect(view.state.doc.toString()).toBe('git rem')
})

it('Enter uses the session binder', () => {
  const editor = readFileSync(
    'src/renderer/components/terminal/command-editor/CommandEditor.tsx',
    'utf8'
  )
  const binder = readFileSync('src/renderer/lib/command-lifecycle/bind-session.ts', 'utf8')
  readFileSync('src/renderer/components/terminal/ConnectedTerminal.tsx', 'utf8')
  expect(editor).toMatch(/useBindSessionClient/)
  expect(editor).toMatch(/from ['"]@\/lib\/command-lifecycle\/bind-session['"]/)
  expect(editor).not.toMatch(/terminalApi\.write/)
  expect(binder).toMatch(/useAddCommand\(\)/)
  expect(binder).toMatch(/addCommand/)
  expect(binder).toMatch(/submitDraft/)
})

it('a cursor-only move bumps the buffer revision', async () => {
  type CompletionRequest = Parameters<TerminalApi['requestCompletion']>[1]
  const viewRef: { current: EditorView | null } = { current: null }
  const draftStore = createCommandDraftStore()
  const terminalId = 'rev-terminal'
  sessionStore.apply(terminalId, { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  sessionStore.apply(terminalId, {
    type: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 2,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })

  const timers: Array<{ handler: () => void; id: number }> = []
  let nextTimer = 1
  const clock = {
    setTimeout(handler: () => void, _ms: number) {
      const id = nextTimer++
      timers.push({ handler, id })
      return id
    },
    clearTimeout(id: unknown) {
      const idx = timers.findIndex((t) => t.id === id)
      if (idx >= 0) timers.splice(idx, 1)
    }
  }
  const flushTimers = () => {
    for (const timer of [...timers]) {
      const idx = timers.indexOf(timer)
      if (idx >= 0) timers.splice(idx, 1)
      timer.handler()
    }
  }

  const requests: Array<{
    request: CompletionRequest
    resolve: (reply: CompletionRpcReply) => void
  }> = []
  const acceptedResults: CompletionReplyFields[] = []
  let nextReq = 0
  const scheduler = new CompletionScheduler({
    host: {
      requestCompletion(_id, request) {
        return new Promise<CompletionRpcReply>((resolve) => {
          requests.push({ request, resolve })
        })
      },
      cancelCompletion: async () => 'Accepted'
    },
    createRequestId: () => `req-${++nextReq}`,
    settings: { automaticCompletionRefresh: true },
    clock,
    onResult: (completion) => acceptedResults.push(completion)
  })

  const source = {
    rows: () => [{ text: 'status', from: 4, to: 7 }],
    request: () => {}
  }

  render(
    <CommandEditor
      terminalId={terminalId}
      ptyId={() => 'pty-1'}
      focused={true}
      viewRef={viewRef}
      draftStore={draftStore}
      completionSource={source}
      scheduler={scheduler}
    />
  )
  const view = viewRef.current!

  act(() => {
    view.dispatch({
      changes: { from: 0, to: 0, insert: 'git st' },
      selection: { anchor: 6 },
      userEvent: 'input.type'
    })
  })
  flushTimers()

  expect(requests).toHaveLength(1)
  const r = requests[0]!.request.bufferRevision
  expect(requests[0]!.request).toEqual({
    requestId: 'req-1',
    draft: 'git st',
    bufferRevision: r,
    cursor: 6,
    promptGeneration: 2,
    cwd: '/repo'
  })

  // Cursor-only move while req-1 for revision r is in flight (no doc change)
  act(() => {
    view.dispatch({ selection: { anchor: 3 } })
  })

  requests[0]!.resolve({
    result: 'Accepted',
    outcome: 'Completed',
    completion: {
      session_id: 's1',
      nonce: 'n1',
      request_id: 'req-1',
      buffer_revision: r,
      cursor: 6,
      prompt_generation: 2,
      cwd: '/repo',
      output: '737461747573'
    }
  })
  await Promise.resolve()

  expect(acceptedResults).toEqual([])
  expect(requests).toHaveLength(2)
  expect(requests[1]!.request).toEqual({
    requestId: 'req-2',
    draft: 'git st',
    bufferRevision: r + 1,
    cursor: 3,
    promptGeneration: 2,
    cwd: '/repo'
  })

  requests[1]!.resolve({ result: 'Accepted', outcome: 'TimedOut' })
  await Promise.resolve()

  // Doc change also bumps the revision
  act(() => {
    view.dispatch({
      changes: { from: 6, insert: 'a' },
      selection: { anchor: 7 },
      userEvent: 'input.type'
    })
  })
  flushTimers()
  expect(requests).toHaveLength(3)
  expect(requests[2]!.request).toEqual({
    requestId: 'req-3',
    draft: 'git sta',
    bufferRevision: r + 2,
    cursor: 7,
    promptGeneration: 2,
    cwd: '/repo'
  })

  requests[2]!.resolve({ result: 'Accepted', outcome: 'TimedOut' })
  await Promise.resolve()

  // Ghost text is not part of the revision (T8)
  act(() => {
    startCompletion(view)
  })
  await waitFor(() => expect(completionStatus(view.state)).toBe('active'))
  expect(ghostText(view.state)).toBe('tus')
  flushTimers()
  expect(requests).toHaveLength(3)

  // IME composition also bumps the revision without draft-persistence writing early
  fireEvent.compositionStart(view.contentDOM)
  act(() => {
    view.dispatch({
      changes: { from: 7, insert: 't' },
      selection: { anchor: 8 },
      userEvent: 'input.type.compose'
    })
  })
  flushTimers()
  expect(requests).toHaveLength(4)
  expect(requests[3]!.request).toEqual({
    requestId: 'req-4',
    draft: 'git stat',
    bufferRevision: r + 3,
    cursor: 8,
    promptGeneration: 2,
    cwd: '/repo'
  })
})
