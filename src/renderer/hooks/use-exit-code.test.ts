import type { TerminalApi } from '@shared/types/ipc.types'
import { listen } from '@tauri-apps/api/event'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { terminalApi } from '@/lib/api'
import * as logApi from '@/lib/log-api'
import { createTauriTerminalApi } from '@/lib/tauri-terminal-api'
import { mockTerminal } from '@/lib/test-utils/terminal'
import { createWebTerminalApi, WebTerminalClient } from '@/lib/web-terminal-api'
import { useTerminalStore } from '@/stores/terminal-store'
import {
  disposeExitCodeBuffer,
  exitCodeBuffer,
  heldExitCodeCount,
  MAX_HELD_EXIT_CODES
} from './exit-code-buffer'
import { useExitCode } from './use-exit-code'

afterEach(() => {
  cleanup()
  disposeExitCodeBuffer()
  vi.restoreAllMocks()
  useTerminalStore.getState().setTerminals([])
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

function mountExitCodeHook(surface: 'tauri' | 'web'): {
  emit: (ptyId: string, code: number) => void
  unmount: () => void
} {
  let api: TerminalApi
  let emit: (ptyId: string, code: number) => void
  if (surface === 'tauri') {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    vi.mocked(listen).mockClear()
    api = createTauriTerminalApi()
    emit = (ptyId, code) => {
      const handler = vi
        .mocked(listen)
        .mock.calls.find(([name]) => name === 'terminal-exit-code-changed')?.[1]
      expect(handler).toBeTypeOf('function')
      ;(handler as (event: unknown) => void)({
        payload: { terminalId: ptyId, exitCode: code }
      })
    }
  } else {
    let client!: WebTerminalClient
    const subscribe = WebTerminalClient.prototype.onExitCode
    vi.spyOn(WebTerminalClient.prototype, 'onExitCode').mockImplementation(function (
      this: WebTerminalClient,
      callback
    ) {
      client = this
      return subscribe.call(this, callback)
    })
    api = createWebTerminalApi()
    emit = (ptyId, code) =>
      (client as unknown as { handleEvent(event: unknown): void }).handleEvent({
        type: 'exit_code_changed',
        terminal_id: ptyId,
        exit_code: code
      })
  }
  vi.spyOn(terminalApi, 'onExitCodeChanged').mockImplementation(api.onExitCodeChanged)
  const { unmount } = renderHook(() => useExitCode())
  return { emit, unmount }
}

for (const surface of ['tauri', 'web'] as const) {
  it(`applies each held code once when ${surface} bulk binds through setTerminals`, () => {
    let applies = 0
    const unsubscribe = useTerminalStore.subscribe((state) => {
      if (state.terminals.some((terminal) => terminal.lastExitCode !== undefined)) applies++
    })
    const { emit } = mountExitCodeHook(surface)
    const log = vi.spyOn(logApi, 'logFrontendError')
    act(() => {
      emit('pty-a', 1)
      emit('pty-b', 2)
      emit('pty-c', 3)
    })
    log.mockClear()
    act(() => {
      useTerminalStore
        .getState()
        .setTerminals([
          mockTerminal({ id: 'a', ptyId: 'pty-a' }),
          mockTerminal({ id: 'b', ptyId: 'pty-b' }),
          mockTerminal({ id: 'c', ptyId: 'pty-c' })
        ])
    })
    unsubscribe()
    expect(useTerminalStore.getState().terminals.map((t) => t.lastExitCode)).toEqual([1, 2, 3])
    expect(applies).toBe(3)
    expect(heldExitCodeCount()).toBe(0)
    expect(log.mock.calls.filter(([entry]) => entry.level === 'info')).toHaveLength(1)
  })

  it(`preserves a reentrant newer code after ${surface} first applies B`, () => {
    const { emit } = mountExitCodeHook(surface)
    act(() => {
      emit('pty-a', 1)
      emit('pty-b', 2)
    })
    let updated = false
    const unsubscribe = useTerminalStore.subscribe((state) => {
      if (!updated && state.findTerminalByPtyId('pty-b')?.lastExitCode === 2) {
        updated = true
        exitCodeBuffer.handle('pty-b', 99)
      }
    })
    try {
      act(() => {
        useTerminalStore
          .getState()
          .setTerminals([
            mockTerminal({ id: 'a', ptyId: 'pty-a' }),
            mockTerminal({ id: 'b', ptyId: 'pty-b' })
          ])
      })
      expect(updated).toBe(true)
      expect(useTerminalStore.getState().findTerminalByPtyId('pty-b')?.lastExitCode).toBe(99)
      expect(heldExitCodeCount()).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  it(`keeps codes held before ${surface} connects and flushes the current binding`, () => {
    exitCodeBuffer.handle('host-pty', 7)
    expect(heldExitCodeCount()).toBe(1)
    useTerminalStore.getState().setTerminals([mockTerminal({ id: 'record', ptyId: 'host-pty' })])
    expect(
      useTerminalStore.getState().findTerminalByPtyId('host-pty')?.lastExitCode
    ).toBeUndefined()
    mountExitCodeHook(surface)
    expect(useTerminalStore.getState().findTerminalByPtyId('host-pty')?.lastExitCode).toBe(7)
    expect(heldExitCodeCount()).toBe(0)
  })

  it(`updates lastExitCode from the host tracker through ${surface} and useExitCode`, async () => {
    useTerminalStore.getState().setTerminals([mockTerminal({ id: 'record', ptyId: 'host-pty' })])
    let api: TerminalApi
    let emit: (code: number) => void
    if (surface === 'tauri') {
      ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
      vi.mocked(listen).mockClear()
      api = createTauriTerminalApi()
      emit = (code) => {
        const handler = vi
          .mocked(listen)
          .mock.calls.find(([name]) => name === 'terminal-exit-code-changed')?.[1]
        expect(handler).toBeTypeOf('function')
        ;(handler as (event: unknown) => void)({
          payload: { terminalId: 'host-pty', exitCode: code }
        })
      }
    } else {
      let client!: WebTerminalClient
      const subscribe = WebTerminalClient.prototype.onExitCode
      vi.spyOn(WebTerminalClient.prototype, 'onExitCode').mockImplementation(function (
        this: WebTerminalClient,
        callback
      ) {
        client = this
        return subscribe.call(this, callback)
      })
      api = createWebTerminalApi()
      emit = (code) =>
        (client as unknown as { handleEvent(event: unknown): void }).handleEvent({
          type: 'exit_code_changed',
          terminal_id: 'host-pty',
          exit_code: code
        })
    }
    vi.spyOn(terminalApi, 'onExitCodeChanged').mockImplementation(api.onExitCodeChanged)
    const { unmount } = renderHook(() => useExitCode())
    act(() => emit(7))
    expect(useTerminalStore.getState().findTerminalByPtyId('host-pty')?.lastExitCode).toBe(7)
    act(() => emit(7))
    expect(useTerminalStore.getState().findTerminalByPtyId('host-pty')?.lastExitCode).toBe(7)
    unmount()
    act(() => emit(9))
    expect(useTerminalStore.getState().findTerminalByPtyId('host-pty')?.lastExitCode).toBe(7)
    await Promise.resolve()
  })

  it(`applies a held exit code when ${surface} binds the PTY via setTerminalPtyId`, () => {
    useTerminalStore.getState().setTerminals([mockTerminal({ id: 'record' })])
    const { emit, unmount } = mountExitCodeHook(surface)
    act(() => emit('host-pty', 7))
    expect(useTerminalStore.getState().findTerminalByPtyId('host-pty')).toBeUndefined()
    expect(useTerminalStore.getState().terminals[0]?.lastExitCode).toBeUndefined()
    act(() => {
      useTerminalStore.getState().setTerminalPtyId('record', 'host-pty')
    })
    expect(useTerminalStore.getState().findTerminalByPtyId('host-pty')?.lastExitCode).toBe(7)
    expect(heldExitCodeCount()).toBe(0)
    unmount()
  })

  it(`updates a bound PTY immediately on ${surface} without buffering`, () => {
    useTerminalStore.getState().setTerminals([mockTerminal({ id: 'record', ptyId: 'host-pty' })])
    const { emit, unmount } = mountExitCodeHook(surface)
    act(() => emit('host-pty', 7))
    expect(useTerminalStore.getState().findTerminalByPtyId('host-pty')?.lastExitCode).toBe(7)
    expect(heldExitCodeCount()).toBe(0)
    unmount()
  })

  it(`keeps the latest held exit code for an unbound PTY on ${surface}`, () => {
    useTerminalStore.getState().setTerminals([mockTerminal({ id: 'record' })])
    const { emit, unmount } = mountExitCodeHook(surface)
    act(() => emit('host-pty', 1))
    act(() => emit('host-pty', 2))
    expect(heldExitCodeCount()).toBe(1)
    act(() => {
      useTerminalStore.getState().setTerminalPtyId('record', 'host-pty')
    })
    expect(useTerminalStore.getState().findTerminalByPtyId('host-pty')?.lastExitCode).toBe(2)
    expect(heldExitCodeCount()).toBe(0)
    unmount()
  })

  it(`applies a held ${surface} exit code once and ignores later store changes`, () => {
    useTerminalStore.getState().setTerminals([mockTerminal({ id: 'record' })])
    const { emit, unmount } = mountExitCodeHook(surface)
    act(() => emit('host-pty', 3))
    act(() => {
      useTerminalStore.getState().setTerminalPtyId('record', 'host-pty')
    })
    expect(useTerminalStore.getState().findTerminalByPtyId('host-pty')?.lastExitCode).toBe(3)
    act(() => emit('host-pty', 11))
    expect(useTerminalStore.getState().findTerminalByPtyId('host-pty')?.lastExitCode).toBe(11)
    act(() => {
      useTerminalStore.getState().renameTerminal('record', 'renamed')
    })
    expect(useTerminalStore.getState().findTerminalByPtyId('host-pty')?.lastExitCode).toBe(11)
    expect(heldExitCodeCount()).toBe(0)
    unmount()
  })

  it(`evicts the oldest unbound PTY at the cap on ${surface}`, () => {
    const records = Array.from({ length: MAX_HELD_EXIT_CODES + 1 }, (_, i) =>
      mockTerminal({ id: `t-${i}`, name: `T${i}` })
    )
    useTerminalStore.getState().setTerminals(records)
    const { emit, unmount } = mountExitCodeHook(surface)
    let peak = 0
    for (let i = 0; i <= MAX_HELD_EXIT_CODES; i++) {
      act(() => emit(`pty-${i}`, i + 1))
      peak = Math.max(peak, heldExitCodeCount())
    }
    expect(peak).toBeLessThanOrEqual(MAX_HELD_EXIT_CODES)
    expect(heldExitCodeCount()).toBe(MAX_HELD_EXIT_CODES)
    act(() => {
      useTerminalStore.getState().setTerminalPtyId('t-0', 'pty-0')
    })
    expect(useTerminalStore.getState().terminals.find((t) => t.id === 't-0')?.lastExitCode).toBe(
      undefined
    )
    act(() => {
      useTerminalStore
        .getState()
        .setTerminalPtyId(`t-${MAX_HELD_EXIT_CODES}`, `pty-${MAX_HELD_EXIT_CODES}`)
    })
    expect(
      useTerminalStore.getState().terminals.find((t) => t.id === `t-${MAX_HELD_EXIT_CODES}`)
        ?.lastExitCode
    ).toBe(MAX_HELD_EXIT_CODES + 1)
    expect(heldExitCodeCount()).toBe(MAX_HELD_EXIT_CODES - 1)
    unmount()
  })

  it(`releases the store subscription and held codes on unmount through ${surface}`, () => {
    const subscribe = useTerminalStore.subscribe
    const released = vi.fn()
    const spy = vi.spyOn(useTerminalStore, 'subscribe').mockImplementation((listener) => {
      const unsubscribe = subscribe(listener)
      return () => {
        released()
        unsubscribe()
      }
    })
    useTerminalStore.getState().setTerminals([mockTerminal({ id: 'record' })])
    const { emit, unmount } = mountExitCodeHook(surface)
    expect(spy).toHaveBeenCalledTimes(1)
    act(() => emit('host-pty', 4))
    expect(heldExitCodeCount()).toBe(1)
    unmount()
    expect(released).toHaveBeenCalledTimes(1)
    expect(heldExitCodeCount()).toBe(0)
    act(() => {
      useTerminalStore.getState().setTerminalPtyId('record', 'host-pty')
    })
    expect(useTerminalStore.getState().terminals[0]?.lastExitCode).toBeUndefined()
  })
}
