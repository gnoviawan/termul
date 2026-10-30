import { readFileSync } from 'node:fs'
import type { TerminalModes } from '@shared/types/ipc.types'
import type { SessionLifecyclePayload } from '@shared/types/web-terminal-protocol.types'
import type { Terminal } from '@xterm/xterm'
import { afterEach, expect, it, vi } from 'vitest'
import { mockTerminal } from '@/lib/test-utils/terminal'
import { useTerminalStore } from '@/stores/terminal-store'
import { clearRegistry, startTrackingModes } from '@/utils/terminal-registry'
import { commandDraftStore } from './draft-store'
import { bumpEditorRevision, readEditorRevision } from './editor-revision'
import {
  disposeSessionAdapter,
  forwardSessionExit,
  forwardSessionLifecycle
} from './session-adapter'
import { sessionStore } from './session-store'

const event = (
  kind: SessionLifecyclePayload['kind'],
  terminal_id = 'pty'
): SessionLifecyclePayload => ({
  type: 'session_lifecycle',
  kind,
  terminal_id,
  session_id: 's',
  nonce: 'n',
  prompt_generation: 1,
  cwd: '/repo',
  line_empty: true,
  prompt_suppressed: true,
  exit_code: null
})

const replayModes: TerminalModes = {
  alternateScreen: true,
  bracketedPaste: false,
  applicationCursor: false,
  mouseTracking: null,
  sgrMouseMode: false,
  sgrMousePixelsMode: false
}

function trackModes(terminalId: string): (modeNum: number, set: boolean) => void {
  const handlers: { prefix?: string; final: string; cb: (params: number[]) => boolean }[] = []
  const terminal = {
    parser: {
      registerCsiHandler: (
        id: { prefix?: string; final: string },
        cb: (params: number[]) => boolean
      ) => {
        const entry = { prefix: id.prefix, final: id.final, cb, disposed: false }
        handlers.push(entry)
        return {
          dispose: () => {
            entry.disposed = true
          }
        }
      }
    }
  } as unknown as Terminal
  startTrackingModes(terminalId, terminal)
  return (modeNum, set) => {
    for (const handler of handlers) {
      if (handler.prefix === '?' && handler.final === (set ? 'h' : 'l')) handler.cb([modeNum])
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
  sessionStore.reset()
  useTerminalStore.getState().setTerminals([])
  clearRegistry()
  vi.restoreAllMocks()
})

it('forwards events before bind through the real adapter', async () => {
  forwardSessionLifecycle(event('InitShell'))
  forwardSessionLifecycle(event('PromptReady'))
  await import('../../stores/terminal-store')
  await Promise.resolve()
  expect(useTerminalStore.getState().findTerminalByPtyId('pty')).toBeUndefined()
  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't', ptyId: 'pty' })])
  await vi.waitFor(() =>
    expect(sessionStore.read('t')).toMatchObject({
      registered: true,
      trusted: true,
      mode: 'Editor'
    })
  )
})

it('replays lifecycle before a buffered exit and consumes the exit once', async () => {
  const apply = vi.spyOn(sessionStore, 'apply')
  const processExited = vi.spyOn(sessionStore, 'processExited')

  forwardSessionLifecycle(event('InitShell'))
  forwardSessionLifecycle(event('PromptReady'))
  forwardSessionExit('pty')

  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't', ptyId: 'pty' })])
  await vi.waitFor(() => expect(processExited).toHaveBeenCalledTimes(1))

  expect(apply.mock.invocationCallOrder.at(-1)).toBeLessThan(
    processExited.mock.invocationCallOrder[0] as number
  )
  expect(processExited).toHaveBeenCalledWith('t')

  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't', ptyId: 'pty' })])
  expect(processExited).toHaveBeenCalledTimes(1)
})

it('processes an exit immediately when the PTY is already bound', () => {
  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't', ptyId: 'pty' })])
  const processExited = vi.spyOn(sessionStore, 'processExited')

  forwardSessionExit('pty')

  expect(processExited).toHaveBeenCalledTimes(1)
  expect(processExited).toHaveBeenCalledWith('t')
})

it('a PTY rebind invalidates session trust but keeps the draft', async () => {
  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't', ptyId: 'pty-old' })])
  forwardSessionLifecycle(event('InitShell', 'pty-old'))
  forwardSessionLifecycle(event('PromptReady', 'pty-old'))
  await vi.waitFor(() => expect(sessionStore.read('t').mode).toBe('Editor'))
  commandDraftStore.offer('t', 'Editor', 'unfinished draft')

  useTerminalStore.getState().clearTerminalPtyId('pty-old')
  useTerminalStore.getState().setTerminalPtyId('t', 'pty-new')

  expect(sessionStore.read('t')).toMatchObject({ mode: 'raw', trusted: false })
  expect(sessionStore.beginSubmit('t')).toBeNull()
  expect(commandDraftStore.read('t')).toBe('unfinished draft')
})

it('closing a terminal removes its session, draft, and editor revision', async () => {
  useTerminalStore
    .getState()
    .setTerminals([mockTerminal({ id: 't', projectId: 'project', ptyId: 'pty' })])
  forwardSessionLifecycle(event('InitShell'))
  forwardSessionLifecycle(event('PromptReady'))
  await vi.waitFor(() => expect(sessionStore.read('t').mode).toBe('Editor'))
  commandDraftStore.offer('t', 'Editor', 'unfinished draft')
  bumpEditorRevision('t')

  useTerminalStore.getState().closeTerminal('t', 'project')

  expect(sessionStore.read('t')).toMatchObject({ registered: false, trusted: false, mode: 'PTY' })
  expect(commandDraftStore.read('t')).toBe('')
  expect(readEditorRevision('t')).toBe(0)
})

it('alternate-screen mode changes reach the session store', async () => {
  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't', ptyId: 'pty' })])
  forwardSessionLifecycle(event('InitShell'))
  await vi.waitFor(() => expect(sessionStore.read('t').registered).toBe(true))

  const applyMode = trackModes('pty')
  applyMode(1049, true)

  expect(sessionStore.read('t')).toMatchObject({ alternateScreen: true, mode: 'PTY' })
  forwardSessionLifecycle(event('PromptReady'))
  expect(sessionStore.read('t').mode).not.toBe('Editor')

  applyMode(1049, false)
  expect(sessionStore.read('t')).toMatchObject({ alternateScreen: false })
  expect(sessionStore.read('t').mode).not.toBe('Editor')
})

it('an unmapped mode change applies when the terminal record appears', async () => {
  forwardSessionLifecycle(event('InitShell', 'pty'))
  const applyMode = trackModes('pty')
  applyMode(1049, true)
  expect(sessionStore.read('t').alternateScreen).toBe(false)

  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't', ptyId: 'pty' })])
  await vi.waitFor(() => expect(sessionStore.read('t').alternateScreen).toBe(true))
  expect(sessionStore.read('t').mode).toBe('PTY')
})

it('a replayed pty id reaches the store terminal and does not orphan the pty key', async () => {
  forwardSessionLifecycle(event('InitShell', 'pty'))
  const { publishScreenMode } = await import('./session-adapter')
  publishScreenMode('pty', replayModes)
  expect(sessionStore.read('pty').alternateScreen).toBe(false)

  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't', ptyId: 'pty' })])
  await vi.waitFor(() =>
    expect(sessionStore.read('t')).toMatchObject({ alternateScreen: true, mode: 'PTY' })
  )
  expect(sessionStore.read('pty').alternateScreen).toBe(false)
})

it('replayed screen modes reach the session store without a CSI parse', async () => {
  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't', ptyId: 'pty' })])
  const { publishScreenMode } = await import('./session-adapter')
  expect(publishScreenMode).toBeTypeOf('function')
  publishScreenMode('t', replayModes)
  expect(sessionStore.read('t')).toMatchObject({ alternateScreen: true, mode: 'PTY' })
  publishScreenMode('t', null)
  publishScreenMode('t', undefined)
  expect(sessionStore.read('t').alternateScreen).toBe(true)
})

it('restore and replay publish the known screen snapshot', () => {
  const source = readFileSync('src/renderer/components/terminal/ConnectedTerminal.tsx', 'utf8')
  const sites =
    (source.match(/terminal\.write\(buildRehydrateSequences\(/g) ?? []).length +
    (source.match(/restoreScrollback\(/g) ?? []).length
  const afterHelper = source.split('function publishReplayedModes(')[1] ?? ''
  expect(sites).toBeGreaterThan(0)
  expect(afterHelper.match(/publishReplayedModes\(/g) ?? []).toHaveLength(sites)
  expect(afterHelper).toContain('publishScreenMode(')
})

it('a restored alternate buffer reaches the session store without CSI', () => {
  useTerminalStore.getState().setTerminals([mockTerminal({ id: 't', ptyId: 'pty' })])
  const terminal = {
    parser: { registerCsiHandler: () => ({ dispose: () => undefined }) },
    buffer: { active: { type: 'alternate' } }
  } as unknown as Terminal
  startTrackingModes('pty', terminal)
  expect(sessionStore.read('t')).toMatchObject({ alternateScreen: true, mode: 'PTY' })
})

it('disposal releases the terminal-store subscription so a reload subscribes once', async () => {
  disposeSessionAdapter()
  const subscribe = useTerminalStore.subscribe
  const released = vi.fn()
  const spy = vi
    .spyOn(useTerminalStore, 'subscribe')
    .mockImplementation((listener: Parameters<typeof useTerminalStore.subscribe>[0]) => {
      const unsubscribe = subscribe(listener)
      return () => {
        released()
        unsubscribe()
      }
    })
  try {
    forwardSessionLifecycle(event('InitShell', 'pty-a'))
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    disposeSessionAdapter()
    expect(released).toHaveBeenCalledTimes(1)
    forwardSessionLifecycle(event('InitShell', 'pty-a'))
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    useTerminalStore.getState().setTerminals([mockTerminal({ id: 'ta', ptyId: 'pty-a' })])
    expect(sessionStore.read('ta').registered).toBe(true)
  } finally {
    disposeSessionAdapter()
    spy.mockRestore()
  }
})
