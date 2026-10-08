import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingPermission, PendingQuestion } from '@/stores/acp-store'

const { respondPermission, answerQuestion, logFrontendError } = vi.hoisted(() => ({
  respondPermission: vi.fn(async () => {}),
  answerQuestion: vi.fn(async () => {}),
  logFrontendError: vi.fn(async () => {})
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({ useMobileWebShell: () => true }))
vi.mock('@/lib/log-api', () => ({ logFrontendError }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (s: (state: Record<string, unknown>) => unknown) =>
    s({ respondPermission, answerQuestion })
}))

import { AskUserQuestion } from './AskUserQuestion'
import { PermissionPrompt } from './PermissionPrompt'
import { useApprovalDock } from './use-approval-dock'

function permission(requestId: string): PendingPermission {
  return {
    requestId,
    agentId: 'agent-1',
    sessionId: 's1',
    toolCall: { title: 'npm test' },
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
    ]
  } as PendingPermission
}

function question(questionId: string): PendingQuestion {
  return {
    questionId,
    agentId: 'agent-1',
    sessionId: 's1',
    question: 'Which approach?',
    options: [
      { value: 'a', label: 'Plan A' },
      { value: 'b', label: 'Plan B' }
    ]
  } as PendingQuestion
}

interface HarnessProps {
  enabled?: boolean
  oskOpen?: boolean
  permission?: PendingPermission | null
  question?: PendingQuestion | null
  /** A bare stand-in for ElicitationPrompt: only its prompt marker matters here. */
  elicitationId?: string | null
  /** Whether the composer card is mounted (AskUserQuestion replaces it in the app). */
  composer?: boolean
  autoFocusQuestion?: boolean
}

/**
 * Mirrors AgentChatPanel's dock: a root carrying the hook's `onFocus`, an
 * elicitation above, then either the composer card (with the permission prompt
 * embedded at its top) or the question (with a standalone permission prompt).
 */
function Harness({
  enabled = true,
  oskOpen = false,
  permission: perm = null,
  question: ask = null,
  elicitationId = null,
  composer = true,
  autoFocusQuestion = false
}: HarnessProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const { compactDock, onFocus, onBlur } = useApprovalDock({
    rootRef,
    enabled,
    oskOpen,
    permissionId: perm?.requestId ?? null,
    questionId: ask?.questionId ?? null,
    elicitationId
  })
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: test harness mirrors the panel root
    <div
      ref={rootRef}
      onFocus={onFocus}
      onBlur={onBlur}
      data-testid="root"
      data-compact={String(compactDock)}
    >
      <button type="button" data-testid="outside">
        outside
      </button>
      {elicitationId && (
        <div data-approval-prompt={`elicitation:${elicitationId}`}>
          <button type="button">Submit elicitation</button>
        </div>
      )}
      {ask ? (
        <>
          {perm && <PermissionPrompt permission={perm} embedded={false} />}
          <AskUserQuestion question={ask} autoFocusFirstOption={autoFocusQuestion} />
        </>
      ) : (
        composer && (
          <div data-chat-composer="true" tabIndex={-1} data-testid="composer">
            {perm && <PermissionPrompt permission={perm} />}
            <input data-testid="editor" aria-label="editor" />
          </div>
        )
      )}
    </div>
  )
}

const focusEl = (el: HTMLElement): void => {
  act(() => el.focus())
}

describe('useApprovalDock', () => {
  const scrollIntoView = vi.fn()

  beforeEach(() => {
    logFrontendError.mockClear()
    scrollIntoView.mockClear()
    Element.prototype.scrollIntoView = scrollIntoView
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0)
      return 1
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('compactDock', () => {
    it('is on only with the keyboard up and an approval pending on the mobile shell', () => {
      const compact = (): string | null => screen.getByTestId('root').getAttribute('data-compact')

      const { rerender } = render(<Harness oskOpen permission={null} />)
      expect(compact()).toBe('false')

      rerender(<Harness oskOpen permission={permission('r1')} />)
      expect(compact()).toBe('true')

      rerender(<Harness oskOpen permission={null} question={question('q1')} />)
      expect(compact()).toBe('true')

      rerender(<Harness oskOpen permission={null} elicitationId="el-1" />)
      expect(compact()).toBe('true')

      rerender(<Harness oskOpen={false} permission={permission('r1')} />)
      expect(compact()).toBe('false')

      rerender(<Harness enabled={false} oskOpen permission={permission('r1')} />)
      expect(compact()).toBe('false')
    })
  })

  describe('scrolling an approval button into view', () => {
    it('scrolls a focused prompt button when compact', () => {
      render(<Harness oskOpen permission={permission('r1')} />)
      focusEl(screen.getByRole('button', { name: 'Allow once' }))
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    })

    it('does not scroll when the dock is not compact, or for non-prompt focus', () => {
      const { rerender } = render(<Harness permission={permission('r1')} />)
      focusEl(screen.getByRole('button', { name: 'Allow once' }))
      expect(scrollIntoView).not.toHaveBeenCalled()

      rerender(<Harness oskOpen permission={permission('r1')} />)
      scrollIntoView.mockClear()
      focusEl(screen.getByLabelText('editor'))
      expect(scrollIntoView).not.toHaveBeenCalled()
    })

    it('scrolls the already focused button when the dock becomes compact', () => {
      const { rerender } = render(<Harness permission={permission('r1')} />)
      focusEl(screen.getByRole('button', { name: 'Allow once' }))
      expect(scrollIntoView).not.toHaveBeenCalled()

      rerender(<Harness oskOpen permission={permission('r1')} />)
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    })
  })

  describe('focus return on resolve', () => {
    it('does not move focus when a permission appears while the user is typing', () => {
      const { rerender } = render(<Harness permission={null} />)
      focusEl(screen.getByLabelText('editor'))

      rerender(<Harness permission={permission('r1')} />)

      expect(screen.getByLabelText('editor')).toHaveFocus()
    })

    it('moves focus from a resolved permission to the composer card, not the editor', () => {
      const { rerender } = render(<Harness permission={permission('r1')} />)
      focusEl(screen.getByRole('button', { name: 'Allow once' }))

      rerender(<Harness permission={null} />)

      expect(screen.getByTestId('composer')).toHaveFocus()
      expect(screen.getByTestId('composer')).toHaveAttribute('tabindex', '-1')
      expect(screen.getByLabelText('editor')).not.toHaveFocus()
    })

    it('moves focus off a surviving button when the next request replaces the resolved one', () => {
      const { rerender } = render(<Harness permission={permission('r1')} />)
      const allow = screen.getByRole('button', { name: 'Allow once' })
      focusEl(allow)

      rerender(<Harness permission={permission('r2')} />)

      // Same mounted prompt, same button: it must not keep focus one keypress
      // away from approving the next request.
      expect(screen.getByRole('button', { name: 'Allow once' })).toBe(allow)
      expect(allow).not.toHaveFocus()
      expect(screen.getByTestId('composer')).toHaveFocus()
    })

    it('leaves focus alone when the user had already moved it into the editor', () => {
      const { rerender } = render(<Harness permission={permission('r1')} />)
      focusEl(screen.getByRole('button', { name: 'Allow once' }))
      focusEl(screen.getByLabelText('editor'))

      rerender(<Harness permission={null} />)

      expect(screen.getByLabelText('editor')).toHaveFocus()
    })

    it('leaves focus alone when it sits outside the panel', () => {
      const outside = document.createElement('button')
      document.body.append(outside)
      const { rerender } = render(<Harness permission={permission('r1')} />)
      focusEl(screen.getByRole('button', { name: 'Allow once' }))
      focusEl(outside)

      rerender(<Harness permission={null} />)

      expect(outside).toHaveFocus()
      outside.remove()
    })

    it('leaves focus alone when the user tapped away from the prompt before it resolved', () => {
      const { rerender } = render(<Harness permission={permission('r1')} />)
      const allow = screen.getByRole('button', { name: 'Allow once' })
      focusEl(allow)
      // Tapping a non-focusable area drops focus to <body> with no new target.
      act(() => allow.blur())
      expect(document.body).toHaveFocus()

      rerender(<Harness permission={null} />)

      expect(document.body).toHaveFocus()
      expect(screen.getByTestId('composer')).not.toHaveFocus()
    })

    it('leaves focus alone when it went outside the panel and then dropped to the body', () => {
      const outside = document.createElement('button')
      document.body.append(outside)
      const { rerender } = render(<Harness permission={permission('r1')} />)
      focusEl(screen.getByRole('button', { name: 'Allow once' }))
      focusEl(outside)
      // The root never sees this blur (the element is outside it), so the record
      // must already be gone: a drop to <body> is not the prompt's removal.
      act(() => outside.blur())
      expect(document.body).toHaveFocus()

      rerender(<Harness permission={null} />)

      expect(document.body).toHaveFocus()
      expect(screen.getByTestId('composer')).not.toHaveFocus()
      outside.remove()
    })

    it('keeps the record while focus still sits on the element (window blur)', () => {
      const { rerender } = render(<Harness permission={permission('r1')} />)
      const allow = screen.getByRole('button', { name: 'Allow once' })
      focusEl(allow)
      // A blur with no relatedTarget while the element stays the active element
      // (the window lost focus): the prompt still holds focus.
      fireEvent.blur(allow)
      expect(allow).toHaveFocus()

      rerender(<Harness permission={null} />)

      expect(screen.getByTestId('composer')).toHaveFocus()
    })

    it('moves focus from a resolved question to the composer card', () => {
      const { rerender } = render(
        <Harness composer={false} question={question('q1')} autoFocusQuestion />
      )
      expect(screen.getByRole('button', { name: /Plan A/ })).toHaveFocus()

      rerender(<Harness question={null} />)

      expect(screen.getByTestId('composer')).toHaveFocus()
    })

    it('moves focus from a resolved elicitation to the composer card', () => {
      const { rerender } = render(<Harness elicitationId="el-1" />)
      focusEl(screen.getByRole('button', { name: 'Submit elicitation' }))

      rerender(<Harness elicitationId={null} />)

      expect(screen.getByTestId('composer')).toHaveFocus()
    })

    it("moves focus to the open question's first option when no composer is mounted", () => {
      const { rerender } = render(
        <Harness composer={false} question={question('q1')} permission={permission('r1')} />
      )
      focusEl(screen.getByRole('button', { name: 'Allow once' }))

      rerender(<Harness composer={false} question={question('q1')} permission={null} />)

      expect(screen.getByRole('button', { name: /Plan A/ })).toHaveFocus()
    })

    it('warns and leaves focus untouched when there is no composer and no question', () => {
      const { rerender } = render(<Harness composer={false} elicitationId="el-1" />)
      focusEl(screen.getByRole('button', { name: 'Submit elicitation' }))
      logFrontendError.mockClear()

      rerender(<Harness composer={false} elicitationId={null} />)

      expect(document.body).toHaveFocus()
      expect(logFrontendError).toHaveBeenCalledTimes(1)
      expect(logFrontendError).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }))
    })

    it('does nothing while the question it belongs to stays open', () => {
      render(<Harness composer={false} question={question('q1')} autoFocusQuestion />)
      expect(screen.getByRole('button', { name: /Plan A/ })).toHaveFocus()
      expect(logFrontendError).not.toHaveBeenCalled()
    })
  })

  describe('when disabled (desktop or a hidden pane)', () => {
    it('is inert: no focus return, no scrolling', () => {
      const { rerender } = render(<Harness enabled={false} oskOpen permission={permission('r1')} />)
      focusEl(screen.getByRole('button', { name: 'Allow once' }))
      expect(scrollIntoView).not.toHaveBeenCalled()

      rerender(<Harness enabled={false} oskOpen permission={null} />)

      expect(document.body).toHaveFocus()
      expect(logFrontendError).not.toHaveBeenCalled()
    })
  })
})
