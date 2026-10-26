import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FindWidget } from './FindWidget'

type Props = ComponentProps<typeof FindWidget>

/** Renders the widget inside the TooltipProvider the app root supplies, with spy handlers. */
function renderWidget(overrides: Partial<Props> = {}) {
  const props: Props = {
    search: 'needle',
    onSearchChange: vi.fn(),
    options: { caseSensitive: false, wholeWord: false, regexp: false },
    onOptionsChange: vi.fn(),
    status: { kind: 'matches', current: 1, total: 3, capped: false },
    onNext: vi.fn(),
    onPrevious: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  }
  const view = render(
    <TooltipProvider>
      <FindWidget {...props} />
    </TooltipProvider>
  )
  return { props, ...view }
}

const findField = () => screen.getByRole('textbox', { name: 'Find' })

describe('FindWidget', () => {
  it.each([
    [{ kind: 'matches', current: 2, total: 12, capped: false }, '2 of 12'],
    [{ kind: 'matches', current: 0, total: 12, capped: false }, '? of 12'],
    [{ kind: 'matches', current: 1, total: 1000, capped: true }, '1 of 1000+'],
    [{ kind: 'matches', current: 0, total: 0, capped: false }, 'No results'],
    [{ kind: 'invalid' }, 'Invalid regex']
  ] as const)('labels %o as "%s"', (status, label) => {
    renderWidget({ status })
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  it('disables previous and next without matches', () => {
    renderWidget({ status: { kind: 'matches', current: 0, total: 0, capped: false } })
    expect(screen.getByRole('button', { name: 'Previous match' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled()
  })

  it('finds next on Enter, previous on Shift+Enter and closes on Escape', () => {
    const { props } = renderWidget()
    fireEvent.keyDown(findField(), { key: 'Enter' })
    fireEvent.keyDown(findField(), { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(findField(), { key: 'Escape' })
    expect(props.onNext).toHaveBeenCalledTimes(1)
    expect(props.onPrevious).toHaveBeenCalledTimes(1)
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['mid composition', { isComposing: true }],
    ['Safari composition-confirming Enter (keyCode 229)', { keyCode: 229, isComposing: false }]
  ])('ignores the IME %s', (_, init) => {
    const replace = {
      open: true,
      onOpenChange: vi.fn(),
      value: 'pin',
      onValueChange: vi.fn(),
      onReplace: vi.fn(),
      onReplaceAll: vi.fn()
    }
    const { props } = renderWidget({ replace })
    fireEvent.keyDown(findField(), { key: 'Enter', ...init })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Replace' }), { key: 'Enter', ...init })
    expect(props.onNext).not.toHaveBeenCalled()
    expect(replace.onReplace).not.toHaveBeenCalled()
  })

  it('toggles options with Alt+C, Alt+W and Alt+R', () => {
    const { props } = renderWidget()
    fireEvent.keyDown(findField(), { key: 'c', code: 'KeyC', altKey: true })
    fireEvent.keyDown(findField(), { key: 'w', code: 'KeyW', altKey: true })
    fireEvent.keyDown(findField(), { key: 'r', code: 'KeyR', altKey: true })
    expect(props.onOptionsChange).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ caseSensitive: true })
    )
    expect(props.onOptionsChange).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ wholeWord: true })
    )
    expect(props.onOptionsChange).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ regexp: true })
    )
  })

  it('shows pressed options', () => {
    renderWidget({ options: { caseSensitive: true, wholeWord: false, regexp: false } })
    expect(screen.getByRole('button', { name: 'Match case' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Match whole word' })).toHaveAttribute(
      'aria-pressed',
      'false'
    )
  })

  it('lets the owner handle a key first', () => {
    const { props } = renderWidget({ onKeyDown: (event) => event.key === 'Escape' })
    fireEvent.keyDown(findField(), { key: 'Escape' })
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('takes a new query from the owner', () => {
    const { props, rerender } = renderWidget()
    fireEvent.change(findField(), { target: { value: 'needles' } })
    expect(props.onSearchChange).toHaveBeenCalledWith('needles')
    expect(findField()).toHaveValue('needles')

    rerender(
      <TooltipProvider>
        <FindWidget {...props} search="selection" />
      </TooltipProvider>
    )
    expect(findField()).toHaveValue('selection')
  })

  it('has no replace controls without replace', () => {
    renderWidget()
    expect(screen.queryByRole('button', { name: 'Toggle replace' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Replace' })).toBeNull()
  })

  it('replaces on Enter and replaces all on Ctrl+Alt+Enter', () => {
    const replace = {
      open: true,
      onOpenChange: vi.fn(),
      value: 'pin',
      onValueChange: vi.fn(),
      onReplace: vi.fn(),
      onReplaceAll: vi.fn()
    }
    renderWidget({ replace })
    const field = screen.getByRole('textbox', { name: 'Replace' })
    expect(field).toHaveValue('pin')

    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true, altKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Toggle replace' }))

    expect(replace.onReplace).toHaveBeenCalledTimes(1)
    expect(replace.onReplaceAll).toHaveBeenCalledTimes(1)
    expect(replace.onOpenChange).toHaveBeenCalledWith(false)
  })

  it('hides the replace row while it is closed', () => {
    renderWidget({
      replace: {
        open: false,
        onOpenChange: vi.fn(),
        value: '',
        onValueChange: vi.fn(),
        onReplace: vi.fn(),
        onReplaceAll: vi.fn()
      }
    })
    expect(screen.getByRole('button', { name: 'Toggle replace' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByRole('textbox', { name: 'Replace' })).toBeNull()
  })
})
