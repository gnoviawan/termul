import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Story 12 (QA F12 / matrix rows 4+2): copy + radius-scale contracts that
// span multiple components —
//   - ChatHistoryTab empty-state CTA case matches the actual "New chat" button
//   - centered modals share one radius scale (rounded-2xl, no sm:rounded-*)

const { chatSessionIndexRef, chatProjectRef } = vi.hoisted(() => ({
  chatSessionIndexRef: { current: [] as unknown[] },
  chatProjectRef: { current: null as unknown }
}))

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessionIndex: chatSessionIndexRef.current,
      openHistorySession: vi.fn(),
      openDiscoveredSession: vi.fn(),
      deleteHistorySession: vi.fn()
    })
}))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) => selector({ addAgentChatTab: vi.fn() })
}))

vi.mock('@/stores/project-store', () => ({
  useActiveProject: () => chatProjectRef.current,
  getActiveWorktreeFromStore: () => null
}))

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ChatHistoryTab } from './ChatHistoryTab'

describe('ChatHistoryTab copy (story 12)', () => {
  beforeEach(() => {
    chatSessionIndexRef.current = []
    chatProjectRef.current = { id: 'p1', path: '/work', activeWorktreeId: null, worktrees: [] }
  })

  it('empty-state CTA references the button with matching case ("New chat")', () => {
    render(<ChatHistoryTab />)

    // The actual button label in the mobile drawer is "New chat" (title-case
    // "Chat" was a case mismatch — QA F12).
    expect(
      screen.getByText('No chats yet. Start one with the New chat button.')
    ).toBeInTheDocument()
    expect(
      screen.queryByText('No chats yet. Start one with the New Chat button.')
    ).not.toBeInTheDocument()
  })
})

describe('centered modal radius scale (story 12)', () => {
  it('Dialog defaults to rounded-2xl (no sm:rounded-xl)', () => {
    render(
      <Dialog open onOpenChange={vi.fn()}>
        <DialogContent aria-label="Sample">
          <DialogTitle>Sample</DialogTitle>
        </DialogContent>
      </Dialog>
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('rounded-2xl')
    expect(dialog.className).not.toContain('sm:rounded-xl')
    expect(dialog.className).not.toContain('sm:rounded-lg')
  })

  it('AlertDialog defaults to rounded-2xl (no sm:rounded-lg)', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTrigger asChild>
            <span>never</span>
          </AlertDialogTrigger>
          <AlertDialogAction>OK</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    )

    const dialog = screen.getByRole('alertdialog')
    expect(dialog.className).toContain('rounded-2xl')
    expect(dialog.className).not.toContain('sm:rounded-lg')
    expect(dialog.className).not.toContain('sm:rounded-xl')
  })
})
