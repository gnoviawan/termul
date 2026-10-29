import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMac } from '@/lib/platform'
import { useKeyboardShortcutsStore } from '@/stores/keyboard-shortcuts-store'
import { SelectionContextLayer } from './SelectionContextLayer'

function renderLayer(onAdd = vi.fn()) {
  render(
    <>
      <SelectionContextLayer onAdd={onAdd}>
        <div data-selection-context-source="">
          <p data-testid="prose">The agent explains the bug.</p>
          <div data-streamdown="code-block-body" data-language="ts">
            <pre>
              <code data-testid="code">const x = 1</code>
            </pre>
          </div>
        </div>
        <div data-selection-context-source="">
          <p data-testid="user">My own question</p>
        </div>
        <div data-testid="tool">Tool output</div>
      </SelectionContextLayer>
      <div contentEditable data-testid="composer" suppressContentEditableWarning>
        draft text
      </div>
    </>
  )
  return onAdd
}

function select(testId: string): void {
  const node = screen.getByTestId(testId)
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  act(() => {
    document.dispatchEvent(new Event('selectionchange'))
  })
}

function pressShortcut(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'l',
    bubbles: true,
    cancelable: true,
    metaKey: isMac,
    ctrlKey: !isMac
  })
  act(() => {
    document.dispatchEvent(event)
  })
  return event
}

afterEach(() => {
  document.getSelection()?.removeAllRanges()
  useKeyboardShortcutsStore.getState().resetAllShortcuts()
})

describe('SelectionContextLayer', () => {
  it('shows an "Add to context" button for a selection in an agent message and adds it', async () => {
    const onAdd = renderLayer()
    select('prose')

    const button = screen.getByRole('button', { name: 'Add to context' })
    fireEvent.click(button)

    expect(onAdd).toHaveBeenCalledWith({ text: 'The agent explains the bug.' })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add to context' })).toBeNull())
  })

  it('keeps the button mounted while it is being pressed, so the click lands', () => {
    const onAdd = renderLayer()
    select('prose')
    const button = screen.getByRole('button', { name: 'Add to context' })
    fireEvent.pointerDown(button, { pointerType: 'mouse' })
    expect(screen.getByRole('button', { name: 'Add to context' })).toBe(button)
    fireEvent.pointerUp(button, { pointerType: 'mouse' })
    fireEvent.click(button)
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('keeps the button on one line and inside the list when the selection is at the right edge', () => {
    renderLayer()
    const rect = (left: number, width: number) =>
      ({
        left,
        width,
        right: left + width,
        top: 200,
        bottom: 220,
        height: 20,
        x: left,
        y: 200
      }) as DOMRect
    const layer = screen.getByTestId('prose').closest('[data-selection-context-source]')
      ?.parentElement as HTMLElement
    vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue(rect(0, 400))
    vi.spyOn(screen.getByTestId('prose'), 'getBoundingClientRect').mockReturnValue(rect(380, 20))
    select('prose')
    const button = screen.getByRole('button', { name: 'Add to context' })
    expect(button.className).toContain('whitespace-nowrap')
    const left = Number.parseFloat((button.parentElement as HTMLElement).style.left)
    expect(left).toBeLessThanOrEqual(400 - 90)
  })

  it('keeps the code language when the selection is inside a code block', () => {
    const onAdd = renderLayer()
    select('code')
    fireEvent.click(screen.getByRole('button', { name: 'Add to context' }))
    expect(onAdd).toHaveBeenCalledWith({ text: 'const x = 1', language: 'ts' })
  })

  it('works for the user own messages too', () => {
    const onAdd = renderLayer()
    select('user')
    fireEvent.click(screen.getByRole('button', { name: 'Add to context' }))
    expect(onAdd).toHaveBeenCalledWith({ text: 'My own question' })
  })

  it('shows no button for a selection outside a chat message', () => {
    renderLayer()
    select('tool')
    expect(screen.queryByRole('button', { name: 'Add to context' })).toBeNull()
    select('composer')
    expect(screen.queryByRole('button', { name: 'Add to context' })).toBeNull()
  })

  it('hides the button when the selection collapses', async () => {
    renderLayer()
    select('prose')
    expect(screen.getByRole('button', { name: 'Add to context' })).toBeTruthy()
    act(() => {
      document.getSelection()?.collapseToStart()
      document.dispatchEvent(new Event('selectionchange'))
    })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add to context' })).toBeNull())
  })

  it('adds the selection with Cmd+L / Ctrl+L', () => {
    const onAdd = renderLayer()
    select('code')
    const event = pressShortcut()
    expect(event.defaultPrevented).toBe(true)
    expect(onAdd).toHaveBeenCalledWith({ text: 'const x = 1', language: 'ts' })
  })

  it('leaves Cmd+L / Ctrl+L alone when no message text is selected', () => {
    const onAdd = renderLayer()
    select('composer')
    const event = pressShortcut()
    expect(event.defaultPrevented).toBe(false)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('defers to a user shortcut bound to the same keys', () => {
    const onAdd = renderLayer()
    const { shortcuts, setShortcuts } = useKeyboardShortcutsStore.getState()
    setShortcuts({
      ...shortcuts,
      commandHistory: { ...shortcuts.commandHistory, customKey: 'ctrl+l' }
    })
    select('prose')
    pressShortcut()
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('does not float the button after a touch selection, but the shortcut still works', () => {
    const onAdd = renderLayer()
    fireEvent.pointerDown(screen.getByTestId('prose'), { pointerType: 'touch' })
    fireEvent.pointerUp(screen.getByTestId('prose'), { pointerType: 'touch' })
    select('prose')
    expect(screen.queryByRole('button', { name: 'Add to context' })).toBeNull()
    pressShortcut()
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('renders children without listeners when adding is unavailable', () => {
    render(
      <SelectionContextLayer>
        <div data-selection-context-source="">
          <p data-testid="prose">text</p>
        </div>
      </SelectionContextLayer>
    )
    select('prose')
    expect(screen.queryByRole('button', { name: 'Add to context' })).toBeNull()
  })
})
