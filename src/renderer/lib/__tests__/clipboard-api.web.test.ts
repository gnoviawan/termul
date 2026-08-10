/**
 * Unit tests for the browser clipboard fallback (CAP-2 / GH-588).
 *
 * Pins that `browserClipboardApi.readText()` resolves via the paste-event
 * capture fallback when `navigator.clipboard` is undefined (plain-HTTP
 * `termul-server` non-secure context), and that `writeText()` falls back to
 * the hidden-textarea + `execCommand('copy')` path symmetrically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Silence the one-shot fallback warn so it never reaches a real fetch.
vi.mock('@/lib/log-api', () => ({
  logFrontendError: vi.fn()
}))

import { __resetClipboardFallbackForTesting, clipboardApi } from '../clipboard-api'

describe('clipboard-api browser fallback (CAP-2 / GH-588)', () => {
  let originalClipboardDesc: PropertyDescriptor | undefined
  let originalExecCommand: typeof document.execCommand

  beforeEach(() => {
    __resetClipboardFallbackForTesting()
    originalClipboardDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    originalExecCommand = document.execCommand
  })

  afterEach(() => {
    if (originalClipboardDesc) {
      Object.defineProperty(navigator, 'clipboard', originalClipboardDesc)
    } else {
      // @ts-expect-error removing the own prop we added; restores prototype lookup
      delete navigator.clipboard
    }
    document.execCommand = originalExecCommand
  })

  /** Shadow `navigator.clipboard` with undefined (simulates a non-secure context). */
  function stubClipboardUndefined(): void {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
      writable: true
    })
  }

  /** Dispatch a `paste` event carrying `text` on `document` (capture-phase target). */
  function dispatchPaste(text: string): void {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? text : '') },
      configurable: true
    })
    document.dispatchEvent(event)
  }

  it('readText resolves via the paste-event fallback when navigator.clipboard is undefined', async () => {
    stubClipboardUndefined()
    expect(navigator.clipboard).toBeUndefined()

    // No buffer yet → readText installs a one-shot wait for the next paste.
    const promise = clipboardApi.readText()
    dispatchPaste('pasted-via-fallback')

    const result = await promise
    expect(result.success).toBe(true)
    expect(result.data).toBe('pasted-via-fallback')
  })

  it('readText returns the buffered paste text without waiting when already captured', async () => {
    stubClipboardUndefined()
    // Prime: a first readText installs the listener + starts a one-shot wait.
    const priming = clipboardApi.readText()
    // A paste resolves the one-shot (and clears the transient buffer it set).
    dispatchPaste('prime')
    await priming
    // Now a paste fires with NO readText waiting → the buffer retains the text
    // (F4: only cleared when handed to a waiter or consumed by a readText).
    dispatchPaste('buffered-text')
    // The next readText finds the buffered text and returns immediately (no wait).
    const result = await clipboardApi.readText()
    expect(result.success).toBe(true)
    expect(result.data).toBe('buffered-text')
  })

  it('readText returns READ_ERROR when no paste arrives within the fallback timeout', async () => {
    stubClipboardUndefined()
    vi.useFakeTimers()
    try {
      const promise = clipboardApi.readText()
      // No paste event dispatched → the one-shot wait times out.
      vi.advanceTimersByTime(5001)
      const result = await promise
      expect(result.success).toBe(false)
      expect(result.code).toBe('READ_ERROR')
    } finally {
      vi.useRealTimers()
    }
  })

  it('writeText falls back to execCommand(copy) via a hidden textarea when navigator.clipboard is undefined', async () => {
    stubClipboardUndefined()
    const execSpy = vi.fn(() => true)
    document.execCommand = execSpy

    const result = await clipboardApi.writeText('copy-via-fallback')

    expect(result.success).toBe(true)
    expect(execSpy).toHaveBeenCalledWith('copy')
    // A hidden textarea was attached to the DOM to hold the text.
    const ta = document.getElementById('termul-clipboard-fallback') as HTMLTextAreaElement | null
    expect(ta, 'hidden fallback textarea should exist').not.toBeNull()
    expect(ta!.value).toBe('copy-via-fallback')
  })

  it('writeText returns WRITE_ERROR when the execCommand fallback fails', async () => {
    stubClipboardUndefined()
    document.execCommand = vi.fn(() => false)

    const result = await clipboardApi.writeText('will-fail')

    expect(result.success).toBe(false)
    expect(result.code).toBe('WRITE_ERROR')
  })
})
