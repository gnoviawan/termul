import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingPermission } from '@/stores/acp-store'

const { mobileRef, respondPermission, toastError, logFrontendError } = vi.hoisted(() => ({
  mobileRef: { current: false },
  respondPermission: vi.fn(async (_requestId: string, _optionId?: string) => {}),
  toastError: vi.fn(),
  logFrontendError: vi.fn(async () => {})
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current
}))
vi.mock('@/lib/log-api', () => ({ logFrontendError }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (s: { respondPermission: typeof respondPermission }) => unknown) =>
    selector({ respondPermission })
}))

import { PermissionPrompt } from './PermissionPrompt'

function permission(requestId = 'req-1', overrides: Partial<PendingPermission> = {}) {
  return {
    requestId,
    agentId: 'agent-1',
    sessionId: 's1',
    toolCall: { title: 'npm test -- auth' },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
    ],
    ...overrides
  } as PendingPermission
}

const MIXED_OPTIONS = [
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'custom', name: 'Ask later' },
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }
]

describe('PermissionPrompt', () => {
  beforeEach(() => {
    mobileRef.current = false
    respondPermission.mockReset().mockResolvedValue(undefined)
    toastError.mockReset()
    logFrontendError.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('desktop baseline', () => {
    it('keeps size="sm" sizing, aria-live and the shipped footnote', () => {
      render(<PermissionPrompt permission={permission()} />)

      const allow = screen.getByRole('button', { name: 'Allow once' })
      expect(allow).toHaveClass('h-8', 'text-xs')
      expect(allow).not.toHaveClass('h-11')
      expect(screen.getByRole('button', { name: 'Reject' })).toHaveClass('h-8', 'text-xs')

      const section = screen.getByTestId('permission-prompt')
      expect(section).toHaveAttribute('aria-live', 'polite')
      expect(section.querySelector('fieldset')).toHaveClass('gap-2')
      expect(section.querySelector('fieldset')).not.toHaveClass('gap-3')

      const footnote = screen.getByText(/Choose an option to resume the agent/)
      expect(footnote.className).toContain('text-[11px]')
      expect(footnote.className).toContain('text-muted-foreground/70')
    })

    it('answers on the first tap, with no activation guard', () => {
      render(<PermissionPrompt permission={permission()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
      expect(respondPermission).toHaveBeenCalledTimes(1)
      expect(respondPermission).toHaveBeenCalledWith('req-1', 'allow-once')
      expect(logFrontendError).not.toHaveBeenCalled()
    })

    it('shows a "Cancel request" fallback at the shipped size when there are no options', () => {
      render(<PermissionPrompt permission={permission('req-1', { options: [] })} />)
      const cancel = screen.getByRole('button', { name: 'Cancel request' })
      expect(cancel).toHaveClass('h-8', 'text-xs')
      fireEvent.click(cancel)
      expect(respondPermission).toHaveBeenCalledWith('req-1', undefined)
    })

    it('tags the section for the dock without touching focus', () => {
      const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
      render(<PermissionPrompt permission={permission()} />)
      expect(screen.getByTestId('permission-prompt')).toHaveAttribute(
        'data-approval-prompt',
        'permission:req-1'
      )
      expect(focusSpy).not.toHaveBeenCalled()
      focusSpy.mockRestore()
    })
  })

  describe('mobile shell', () => {
    beforeEach(() => {
      mobileRef.current = true
    })

    it('uses touch-size options without h-8 / text-xs, gap-3, no aria-live and a legible footnote', () => {
      render(<PermissionPrompt permission={permission()} />)

      for (const name of ['Allow once', 'Reject']) {
        const button = screen.getByRole('button', { name })
        expect(button).toHaveClass('h-11', 'px-3')
        expect(button).not.toHaveClass('h-8')
        expect(button).not.toHaveClass('text-xs')
        // size="touch" pads the hit area by 6px, so gap-3 keeps targets apart.
        expect(button.className).toContain('after:-inset-1.5')
      }

      const section = screen.getByTestId('permission-prompt')
      expect(section).not.toHaveAttribute('aria-live')
      expect(section.querySelector('fieldset')).toHaveClass('gap-3')

      const footnote = screen.getByText(/Choose an option to resume the agent/)
      expect(footnote).toHaveClass('text-2xs', 'text-muted-foreground')
      expect(footnote.className).not.toContain('/70')
      expect(footnote.className).not.toContain('text-[11px]')
    })

    it('does not take focus when it appears', () => {
      const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
      const editor = document.createElement('div')
      editor.tabIndex = 0
      document.body.append(editor)
      editor.focus()
      focusSpy.mockClear()

      render(<PermissionPrompt permission={permission()} />)

      expect(focusSpy).not.toHaveBeenCalled()
      expect(editor).toHaveFocus()
      focusSpy.mockRestore()
      editor.remove()
    })

    it('lists options in code order and fills only the primary allow option', () => {
      render(<PermissionPrompt permission={permission('req-1', { options: MIXED_OPTIONS })} />)

      const buttons = screen
        .getByRole('group', { name: 'Permission options' })
        .querySelectorAll('button')
      expect(Array.from(buttons).map((b) => b.textContent)).toEqual([
        'Always allow',
        'Allow once',
        'Ask later',
        'Reject'
      ])
      expect(screen.getByRole('button', { name: 'Allow once' })).toHaveClass('bg-primary-fill')
      for (const name of ['Always allow', 'Ask later', 'Reject']) {
        expect(screen.getByRole('button', { name })).not.toHaveClass('bg-primary-fill')
      }
    })

    it('ignores a tap within 400ms of mounting and logs it', () => {
      vi.useFakeTimers()
      render(<PermissionPrompt permission={permission()} />)

      fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
      expect(respondPermission).not.toHaveBeenCalled()
      expect(logFrontendError).toHaveBeenCalledTimes(1)
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'info', message: expect.stringContaining('req-1') })
      )

      act(() => {
        vi.advanceTimersByTime(399)
      })
      fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
      expect(respondPermission).not.toHaveBeenCalled()
    })

    it('answers exactly once for a tap at or after 400ms', () => {
      vi.useFakeTimers()
      render(<PermissionPrompt permission={permission()} />)

      act(() => {
        vi.advanceTimersByTime(400)
      })
      fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))

      expect(respondPermission).toHaveBeenCalledTimes(1)
      expect(respondPermission).toHaveBeenCalledWith('req-1', 'allow-once')
    })

    it('is not kept closed by the wall clock stepping backwards', () => {
      vi.useFakeTimers()
      render(<PermissionPrompt permission={permission()} />)
      act(() => {
        vi.advanceTimersByTime(400)
      })

      // An NTP or manual adjustment moves Date.now() back an hour: the guard
      // measures a monotonic clock, so a valid tap still answers.
      vi.setSystemTime(Date.now() - 60 * 60 * 1000)
      fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))

      expect(respondPermission).toHaveBeenCalledTimes(1)
      expect(respondPermission).toHaveBeenCalledWith('req-1', 'allow-once')
    })

    it('restarts the guard when the request changes under the same mounted prompt', () => {
      vi.useFakeTimers()
      const { rerender } = render(<PermissionPrompt permission={permission('req-1')} />)
      act(() => {
        vi.advanceTimersByTime(1000)
      })

      rerender(<PermissionPrompt permission={permission('req-2')} />)
      fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
      expect(respondPermission).not.toHaveBeenCalled()
      expect(logFrontendError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('req-2') })
      )

      act(() => {
        vi.advanceTimersByTime(400)
      })
      fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
      expect(respondPermission).toHaveBeenCalledTimes(1)
      expect(respondPermission).toHaveBeenCalledWith('req-2', 'allow-once')
    })

    it('shows "Cancel request" at touch size and answers with no option after the guard', () => {
      vi.useFakeTimers()
      render(<PermissionPrompt permission={permission('req-1', { options: [] })} />)

      const cancel = screen.getByRole('button', { name: 'Cancel request' })
      expect(cancel).toHaveClass('h-11')
      expect(cancel).not.toHaveClass('h-8')
      expect(cancel).not.toHaveClass('text-xs')

      fireEvent.click(cancel)
      expect(respondPermission).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(400)
      })
      fireEvent.click(cancel)
      expect(respondPermission).toHaveBeenCalledTimes(1)
      expect(respondPermission).toHaveBeenCalledWith('req-1', undefined)
    })

    it('toasts when a valid answer is rejected (the store restores the entry)', async () => {
      vi.useFakeTimers()
      respondPermission.mockRejectedValueOnce(new Error('offline'))
      render(<PermissionPrompt permission={permission()} />)
      act(() => {
        vi.advanceTimersByTime(400)
      })

      fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })

      expect(toastError).toHaveBeenCalledWith('Could not send the permission response. Try again.')
    })
  })
})
