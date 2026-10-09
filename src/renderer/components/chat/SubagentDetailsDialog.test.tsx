import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCall } from '@/lib/acp-api'
import {
  armMobileOverlayBackStack,
  pressSystemBack,
  settleOverlayBackStack,
  waitForSentinelDepth
} from '@/lib/test-utils/overlay-back-stack'
import { readOverlaySentinelDepth, useOverlayStackStore } from '@/stores/overlay-stack-store'
import { SubagentDetailsDialog } from './SubagentDetailsDialog'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

vi.mock('framer-motion', async () => {
  const actual = await vi.importActual<typeof import('framer-motion')>('framer-motion')
  return {
    ...actual,
    useReducedMotion: () => true
  }
})

const delegatedCall: ToolCall = {
  toolCallId: 'task-1',
  title: 'Audit branch code for slop',
  kind: 'think',
  status: 'in_progress',
  rawInput: {
    subagent_type: 'explorer',
    description: 'Audit branch code for slop',
    prompt: 'Inspect the branch without changing files.'
  }
}

function Harness({ onOpenChange }: { onOpenChange?: (open: boolean) => void }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <SubagentDetailsDialog
      toolCall={delegatedCall}
      parentTurnActive
      open={open}
      onOpenChange={(next) => {
        onOpenChange?.(next)
        setOpen(next)
      }}
    />
  )
}

const stackIds = (): string[] => useOverlayStackStore.getState().stack.map((entry) => entry.id)

describe('SubagentDetailsDialog overlay back stack', () => {
  let cleanup: () => void

  beforeEach(() => {
    window.history.replaceState(null, '', '#/base')
    cleanup = armMobileOverlayBackStack()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  describe('mobile shell', () => {
    it('system back removes the dialog, leaves the hash alone and consumes the sentinel', async () => {
      const onOpenChange = vi.fn()
      render(<Harness onOpenChange={onOpenChange} />)

      expect(screen.getByRole('dialog', { name: 'Audit branch code for slop' })).toBeInTheDocument()
      expect(stackIds()[0]).toMatch(/^dialog:/)
      await waitForSentinelDepth(1)

      await pressSystemBack()

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      expect(onOpenChange).toHaveBeenLastCalledWith(false)
      expect(location.hash).toBe('#/base')
      expect(readOverlaySentinelDepth(history.state)).toBe(0)
    })

    it('a close by the X button consumes the sentinel', async () => {
      render(<Harness />)
      await waitForSentinelDepth(1)

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))

      await waitForSentinelDepth(0)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  describe('desktop shell', () => {
    it('is inert: no registration, no history push and no traversal', async () => {
      useOverlayStackStore.getState().setMobileShell(false)
      const pushSpy = vi.spyOn(history, 'pushState')
      const backSpy = vi.spyOn(history, 'back')
      const goSpy = vi.spyOn(history, 'go')
      render(<Harness />)

      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(stackIds()).toEqual([])
      fireEvent.keyDown(document.body, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
      await settleOverlayBackStack()

      expect(pushSpy).not.toHaveBeenCalled()
      expect(backSpy).not.toHaveBeenCalled()
      expect(goSpy).not.toHaveBeenCalled()
    })
  })
})
