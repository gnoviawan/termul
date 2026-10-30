import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mockTerminal } from '@/lib/test-utils/terminal'
import { useTerminalStore } from '@/stores/terminal-store'
import { canTerminalWriteToPty, canWriteToPty } from './input-guard'
import { sessionStore } from './session-store'

afterEach(() => {
  sessionStore.reset()
  useTerminalStore.getState().setTerminals([])
})

function openTrustedEditor(id: string): void {
  sessionStore.apply(id, { type: 'InitShell', session_id: 's1', nonce: 'n1' })
  sessionStore.apply(id, {
    type: 'PromptReady',
    session_id: 's1',
    nonce: 'n1',
    prompt_generation: 1,
    cwd: '/repo',
    line_empty: true,
    prompt_suppressed: true
  })
}

describe('canWriteToPty truth table', () => {
  it('drops all input when mode is Editor', () => {
    for (const data of ['a', '\r', '\x03', 'git status']) {
      expect(canWriteToPty({ mode: 'Editor', phase: 'AtPrompt' }, data)).toBe(false)
      expect(canWriteToPty({ mode: 'Editor', phase: 'Unknown' }, data)).toBe(false)
    }
  })

  it('drops input in Submitting except Ctrl+C (\\x03)', () => {
    for (const data of ['a', '\r', '\n', '\x04', '\x03\x03', 'echo hi']) {
      expect(canWriteToPty({ mode: 'PTY', phase: 'Submitting' }, data)).toBe(false)
    }
    expect(canWriteToPty({ mode: 'PTY', phase: 'Submitting' }, '\x03')).toBe(true)
  })

  it('allows input in PTY Executing, Unknown, and raw modes', () => {
    for (const data of ['a', '\r', '\x03', 'ls -la']) {
      expect(canWriteToPty({ mode: 'PTY', phase: 'Executing' }, data)).toBe(true)
      expect(canWriteToPty({ mode: 'PTY', phase: 'Unknown' }, data)).toBe(true)
      expect(canWriteToPty({ mode: 'raw', phase: 'Unknown' }, data)).toBe(true)
      expect(canWriteToPty({ mode: 'raw', phase: 'Executing' }, data)).toBe(true)
      expect(canWriteToPty({ mode: 'raw', phase: 'Submitting' }, data)).toBe(true)
    }
  })
})

describe('canTerminalWriteToPty with sessionStore lifecycle', () => {
  it('blocks xterm data in Editor and Submitting (except \\x03) and allows raw/Unknown/Executing', () => {
    const write = vi.fn()
    const sendXtermData = (terminalId: string, data: string) => {
      if (!canTerminalWriteToPty(terminalId, data)) return
      write(data)
    }

    // 1. Fresh unintegrated shell: mode is PTY, phase is Unknown -> allowed
    sendXtermData('t1', 'echo raw\r')
    expect(write).toHaveBeenLastCalledWith('echo raw\r')
    write.mockClear()

    // 2. Trusted prompt -> mode is Editor -> dropped
    sessionStore.apply('t1', { type: 'InitShell', session_id: 's1', nonce: 'n1' })
    sessionStore.apply('t1', {
      type: 'PromptReady',
      session_id: 's1',
      nonce: 'n1',
      prompt_generation: 1,
      cwd: '/repo',
      line_empty: true,
      prompt_suppressed: true
    })
    expect(sessionStore.read('t1').mode).toBe('Editor')
    sendXtermData('t1', 'a')
    sendXtermData('t1', '\x03')
    expect(write).not.toHaveBeenCalled()

    // 3. Submitting -> normal keys dropped, \x03 allowed
    sessionStore.beginSubmit('t1')
    expect(sessionStore.read('t1').phase).toBe('Submitting')
    sendXtermData('t1', 'a')
    sendXtermData('t1', '\r')
    expect(write).not.toHaveBeenCalled()
    sendXtermData('t1', '\x03')
    expect(write).toHaveBeenCalledExactlyOnceWith('\x03')
    write.mockClear()

    // 4. Executing -> all keys allowed
    sessionStore.apply('t1', { type: 'CommandStarted', session_id: 's1', nonce: 'n1' })
    expect(sessionStore.read('t1').phase).toBe('Executing')
    sendXtermData('t1', 'y\r')
    expect(write).toHaveBeenCalledExactlyOnceWith('y\r')
    write.mockClear()

    // 5. Desync -> mode is raw -> all keys allowed
    sessionStore.apply('t1', { type: 'Desync', session_id: 's1', nonce: 'n1' })
    expect(sessionStore.read('t1').mode).toBe('raw')
    sendXtermData('t1', 'ls\r')
    expect(write).toHaveBeenCalledExactlyOnceWith('ls\r')
  })

  it('Accepted then Desync lets an ordinary key reach the PTY', () => {
    const write = vi.fn()
    openTrustedEditor('t1')
    const token = sessionStore.beginSubmit('t1')
    expect(token).not.toBeNull()
    expect(sessionStore.recordSubmit('t1', 'Accepted', token!)).toBe(true)
    sessionStore.apply('t1', { type: 'Desync', session_id: 's1', nonce: 'n1' })
    expect(sessionStore.read('t1').mode).toBe('raw')
    if (canTerminalWriteToPty('t1', 'a')) write('a')
    expect(write).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('Partial submit lets an ordinary key reach the PTY', () => {
    const write = vi.fn()
    openTrustedEditor('t1')
    const token = sessionStore.beginSubmit('t1')
    expect(token).not.toBeNull()
    expect(sessionStore.recordSubmit('t1', 'Partial', token!)).toBe(true)
    expect(sessionStore.read('t1').mode).toBe('raw')
    if (canTerminalWriteToPty('t1', 'a')) write('a')
    expect(write).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('Accepted then an unsuppressed newer PromptReady lets an ordinary key reach the PTY', () => {
    const write = vi.fn()
    openTrustedEditor('t1')
    const token = sessionStore.beginSubmit('t1')
    expect(token).not.toBeNull()
    expect(sessionStore.recordSubmit('t1', 'Accepted', token!)).toBe(true)
    expect(sessionStore.read('t1').phase).toBe('Submitting')
    sessionStore.apply('t1', {
      type: 'PromptReady',
      session_id: 's1',
      nonce: 'n1',
      prompt_generation: 2,
      cwd: '/repo',
      line_empty: true,
      prompt_suppressed: false
    })
    expect(sessionStore.read('t1').mode).not.toBe('Editor')
    expect(sessionStore.read('t1').phase).not.toBe('Submitting')
    if (canTerminalWriteToPty('t1', 'a')) write('a')
    expect(write).toHaveBeenCalledExactlyOnceWith('a')
  })

  it('resolves a PTY id to the stable terminal id before reading lifecycle', () => {
    useTerminalStore.getState().setTerminals([mockTerminal({ id: 'term-1', ptyId: 'pty-9' })])
    openTrustedEditor('term-1')
    sessionStore.beginSubmit('term-1')
    expect(canTerminalWriteToPty('pty-9', 'a')).toBe(false)
    expect(canTerminalWriteToPty('pty-9', '\x03')).toBe(true)
  })

  it('ConnectedTerminal wires handleTerminalData and pane focus to the guard and editor', () => {
    const source = readFileSync('src/renderer/components/terminal/ConnectedTerminal.tsx', 'utf8')
    const handleData = source.slice(
      source.indexOf('const handleTerminalData = useCallback('),
      source.indexOf('// Initialize terminal, set up IPC listeners')
    )
    expect(handleData).toContain('canTerminalWriteToPty(')
    const mobileShell = readFileSync('src/renderer/components/mobile/MobileChatShell.tsx', 'utf8')
    expect(mobileShell).toContain('terminalId={activeTerminal.id}')
    expect(mobileShell).not.toContain('terminalId={activeTerminal.ptyId}')
    const paneFocus = source.slice(
      source.indexOf('const focusPaneInput = useCallback('),
      source.indexOf('const handleSelectAll = useCallback(')
    )
    expect(paneFocus).toContain("inputModeRef.current === 'Editor'")
    expect(paneFocus).toContain('hasSelection()')
    expect(paneFocus).toContain('commandEditorViewRef.current.focus()')
  })
})
