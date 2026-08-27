import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readText: vi.fn(),
  copyText: vi.fn(),
  logFrontendError: vi.fn()
}))

vi.mock('@/lib/api', () => ({
  clipboardApi: {
    readText: mocks.readText,
    writeText: vi.fn(),
    hasImage: vi.fn()
  }
}))
vi.mock('@/lib/copy-text', () => ({ copyText: mocks.copyText }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mocks.logFrontendError }))

import { copySelection, cutSelection, pasteIntoFocused, selectAllFocused } from './text-edit-ops'

let execCommandMock: ReturnType<typeof vi.fn>

function createInput(
  value = '',
  opts?: { readOnly?: boolean; disabled?: boolean }
): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.value = value
  if (opts?.readOnly) input.readOnly = true
  if (opts?.disabled) input.disabled = true
  document.body.appendChild(input)
  input.focus()
  return input
}

function createTextarea(value = ''): HTMLTextAreaElement {
  const ta = document.createElement('textarea')
  ta.value = value
  document.body.appendChild(ta)
  ta.focus()
  return ta
}

function createContentEditable(text = 'hello world'): HTMLDivElement {
  const div = document.createElement('div')
  div.setAttribute('contenteditable', 'true')
  div.tabIndex = 0
  div.textContent = text
  document.body.appendChild(div)
  div.focus()
  // jsdom may not fully implement the isContentEditable getter — define it
  // explicitly so getFocusedEditable() recognizes the element.
  Object.defineProperty(div, 'isContentEditable', {
    get: () => true,
    configurable: true
  })
  return div
}

function clearDOM(): void {
  document.body.innerHTML = ''
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur()
  }
}

/** Install a mock execCommand on document (jsdom doesn't define it as own prop). */
function installExecCommandMock(): void {
  execCommandMock = vi.fn(() => true)
  Object.defineProperty(document, 'execCommand', {
    value: execCommandMock,
    configurable: true,
    writable: true
  })
}

function restoreExecCommand(): void {
  delete (document as { execCommand?: unknown }).execCommand
}

/** Install a mock select() on an input/textarea (prototype method, not own). */
function installSelectMock(el: HTMLInputElement | HTMLTextAreaElement): ReturnType<typeof vi.fn> {
  const selectMock = vi.fn()
  Object.defineProperty(el, 'select', {
    value: selectMock,
    configurable: true,
    writable: true
  })
  return selectMock
}

describe('text-edit-ops', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearDOM()
    installExecCommandMock()
  })

  afterEach(() => {
    restoreExecCommand()
    clearDOM()
  })

  // ---- copySelection ----

  describe('copySelection', () => {
    it('copies the selected substring from a focused input (P2: selectionStart/End)', async () => {
      const input = createInput('hello world')
      input.setSelectionRange(0, 5)
      mocks.copyText.mockResolvedValue(true)

      const result = await copySelection()
      expect(result).toBe(true)
      expect(mocks.copyText).toHaveBeenCalledWith('hello')
    })

    it('returns false when no selection exists', async () => {
      createInput('hello world')
      const result = await copySelection()
      expect(result).toBe(false)
      expect(mocks.copyText).not.toHaveBeenCalled()
    })

    it('logs via logFrontendError and returns false when copyText throws (never throws)', async () => {
      const input = createInput('hello world')
      input.setSelectionRange(0, 5)
      mocks.copyText.mockRejectedValue(new Error('copy failed'))

      const result = await copySelection()
      expect(result).toBe(false)
      expect(mocks.logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          message: expect.stringContaining('copySelection')
        })
      )
    })

    it('copies from a contentEditable via window.getSelection()', async () => {
      createContentEditable('editable text')
      vi.spyOn(window, 'getSelection').mockReturnValue({
        toString: () => 'editable text'
      } as unknown as Selection)
      mocks.copyText.mockResolvedValue(true)

      const result = await copySelection()
      expect(result).toBe(true)
      expect(mocks.copyText).toHaveBeenCalledWith('editable text')
    })
  })

  // ---- cutSelection ----

  describe('cutSelection', () => {
    it('copies then calls execCommand(delete) when copy succeeds', async () => {
      const input = createInput('hello world')
      input.setSelectionRange(0, 5)
      mocks.copyText.mockResolvedValue(true)

      const result = await cutSelection()
      expect(result).toBe(true)
      expect(mocks.copyText).toHaveBeenCalledWith('hello')
      expect(execCommandMock).toHaveBeenCalledWith('delete')
    })

    it('does NOT call execCommand(delete) when copy fails (P1 — no data loss)', async () => {
      const input = createInput('hello world')
      input.setSelectionRange(0, 5)
      mocks.copyText.mockResolvedValue(false)

      const result = await cutSelection()
      expect(result).toBe(false)
      expect(execCommandMock).not.toHaveBeenCalled()
    })

    it('returns false for readonly input (P8)', async () => {
      const input = createInput('hello world', { readOnly: true })
      input.setSelectionRange(0, 5)
      mocks.copyText.mockResolvedValue(true)

      const result = await cutSelection()
      expect(result).toBe(false)
      expect(execCommandMock).not.toHaveBeenCalled()
    })

    it('returns false for disabled input (P8)', async () => {
      const input = createInput('hello world', { disabled: true })
      input.setSelectionRange(0, 5)
      mocks.copyText.mockResolvedValue(true)

      const result = await cutSelection()
      expect(result).toBe(false)
      expect(execCommandMock).not.toHaveBeenCalled()
    })

    it('returns false when no editable is focused', async () => {
      vi.spyOn(window, 'getSelection').mockReturnValue({
        toString: () => 'page text'
      } as unknown as Selection)
      mocks.copyText.mockResolvedValue(true)

      const result = await cutSelection()
      expect(result).toBe(false)
      expect(execCommandMock).not.toHaveBeenCalled()
    })

    it('restores the original selection before delete after copyText destroys it', async () => {
      const input = createInput('hello world')
      input.setSelectionRange(0, 5)
      const setSelectionRangeSpy = vi.spyOn(input, 'setSelectionRange')
      // Simulate copyText's non-secure-context fallback (lib/copy-text.ts): it
      // focuses a temporary textarea, destroying the original input selection +
      // focus. cutSelection must restore the selection before delete.
      mocks.copyText.mockImplementation(async () => {
        input.blur()
        return true
      })

      const result = await cutSelection()
      expect(result).toBe(true)
      expect(setSelectionRangeSpy).toHaveBeenCalledWith(0, 5)
      expect(execCommandMock).toHaveBeenCalledWith('delete')
    })
  })

  // ---- pasteIntoFocused ----

  describe('pasteIntoFocused', () => {
    it('reads clipboard + re-focuses + calls execCommand(insertText) (P7)', async () => {
      const input = createInput('hello')
      input.setSelectionRange(5, 5)
      const focusSpy = vi.spyOn(input, 'focus')
      mocks.readText.mockResolvedValue({ success: true, data: ' world' })

      const result = await pasteIntoFocused()
      expect(result).toBe(true)
      expect(mocks.readText).toHaveBeenCalled()
      expect(focusSpy).toHaveBeenCalled()
      expect(execCommandMock).toHaveBeenCalledWith('insertText', false, ' world')
    })

    it('returns false when clipboard read fails', async () => {
      createInput('hello')
      mocks.readText.mockResolvedValue({
        success: false,
        error: 'denied',
        code: 'READ_ERROR'
      })

      const result = await pasteIntoFocused()
      expect(result).toBe(false)
      expect(execCommandMock).not.toHaveBeenCalled()
    })

    it('returns false when clipboard data is empty', async () => {
      createInput('hello')
      mocks.readText.mockResolvedValue({ success: true, data: '' })

      const result = await pasteIntoFocused()
      expect(result).toBe(false)
      expect(execCommandMock).not.toHaveBeenCalled()
    })

    it('returns false for readonly input (P8)', async () => {
      createInput('hello', { readOnly: true })
      mocks.readText.mockResolvedValue({ success: true, data: 'world' })

      const result = await pasteIntoFocused()
      expect(result).toBe(false)
      expect(execCommandMock).not.toHaveBeenCalled()
    })
  })

  // ---- selectAllFocused ----

  describe('selectAllFocused', () => {
    it('calls input.select() for a focused input', () => {
      const input = createInput('hello world')
      const selectSpy = installSelectMock(input)

      const result = selectAllFocused()
      expect(result).toBe(true)
      expect(selectSpy).toHaveBeenCalled()
    })

    it('calls textarea.select() for a focused textarea', () => {
      const ta = createTextarea('hello world')
      const selectSpy = installSelectMock(ta)

      const result = selectAllFocused()
      expect(result).toBe(true)
      expect(selectSpy).toHaveBeenCalled()
    })

    it('calls execCommand(selectAll) for contentEditable', () => {
      createContentEditable()

      const result = selectAllFocused()
      expect(result).toBe(true)
      expect(execCommandMock).toHaveBeenCalledWith('selectAll')
    })

    it('returns false when no editable is focused (P9 — no document-wide fallback)', () => {
      clearDOM()
      const result = selectAllFocused()
      expect(result).toBe(false)
      expect(execCommandMock).not.toHaveBeenCalledWith('selectAll')
    })
  })
})
