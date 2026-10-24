import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

const { readAttachmentBytesMock, isTauriContextMock } = vi.hoisted(() => ({
  readAttachmentBytesMock: vi.fn(),
  isTauriContextMock: vi.fn(() => false)
}))

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

vi.mock('@/lib/attachment-api', () => ({
  readAttachmentBytes: (...args: unknown[]) => readAttachmentBytesMock(...args)
}))

const { openFilePathMock } = vi.hoisted(() => ({
  openFilePathMock: vi.fn(async () => ({ ok: true as const }))
}))

vi.mock('@/lib/file-path-links', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/file-path-links')>()
  return { ...actual, openFilePathFromTerminal: openFilePathMock }
})

vi.mock('@/lib/tauri-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri-runtime')>()
  return { ...actual, isTauriContext: () => isTauriContextMock() }
})

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
      filePathContext={undefined}
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

describe('SubagentDetailsDialog agent prose', () => {
  const subagentReply = 'Edited src/foo.ts as asked.\n\n![chart](out/chart.png)'

  beforeEach(() => {
    isTauriContextMock.mockReturnValue(true)
    readAttachmentBytesMock.mockReset()
    readAttachmentBytesMock.mockResolvedValue(new Uint8Array([65, 66, 67]))
  })

  afterEach(() => {
    isTauriContextMock.mockReturnValue(false)
  })

  it.each([
    [
      'text content blocks',
      {
        ...delegatedCall,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: subagentReply } }]
      } satisfies ToolCall
    ],
    [
      'raw output',
      {
        ...delegatedCall,
        status: 'completed',
        rawOutput: { text: subagentReply }
      } satisfies ToolCall
    ]
  ])('links file paths and resolves relative images from %s', async (_label, toolCall) => {
    render(
      <SubagentDetailsDialog
        toolCall={toolCall}
        open
        onOpenChange={() => {}}
        filePathContext={{ cwd: '/proj', projectRoot: '/proj' }}
      />
    )

    const dialog = screen.getByRole('dialog', { name: 'Audit branch code for slop' })
    const fileButton = within(dialog).getByTestId('termul-file-path')
    expect(fileButton).toHaveAttribute('data-path', 'src/foo.ts')
    expect(fileButton).toHaveTextContent('src/foo.ts')
    await waitFor(() => {
      expect(within(dialog).getByRole('img', { name: 'chart' })).toHaveAttribute(
        'src',
        'data:image/png;base64,QUJD'
      )
    })
    expect(readAttachmentBytesMock).toHaveBeenCalledWith('/proj/out/chart.png')
  })
})

describe('SubagentDetailsDialog subagent activity', () => {
  const child = (id: string, status: ToolCall['status'], path: string): ToolCall => ({
    toolCallId: id,
    kind: 'read',
    status,
    title: `Read ${path}`,
    locations: [{ path }],
    parentToolCallId: 'task-1'
  })

  it('lists the tool calls the subagent made and its streamed text', () => {
    render(
      <SubagentDetailsDialog
        toolCall={{ ...delegatedCall, subagentText: 'Found 3 issues so far.' }}
        childToolCalls={[child('c1', 'completed', 'src/a.ts'), child('c2', 'failed', 'src/b.ts')]}
        parentTurnActive
        open
        onOpenChange={() => {}}
        filePathContext={undefined}
      />
    )

    const activity = screen.getByTestId('subagent-activity')
    expect(activity).toHaveTextContent('Activity · 2 tool calls')
    expect(within(activity).getAllByRole('listitem')).toHaveLength(2)
    expect(within(activity).getByLabelText('Done')).toBeInTheDocument()
    expect(within(activity).getByLabelText('Failed')).toBeInTheDocument()
    expect(screen.getByTestId('subagent-output')).toHaveTextContent('Found 3 issues so far.')
  })

  it('shows only the newest 50 calls of a long subagent run', () => {
    const calls = Array.from({ length: 53 }, (_, i) => child(`c${i}`, 'completed', `f${i}.ts`))
    render(
      <SubagentDetailsDialog
        toolCall={delegatedCall}
        childToolCalls={calls}
        open
        onOpenChange={() => {}}
        filePathContext={undefined}
      />
    )
    const activity = screen.getByTestId('subagent-activity')
    expect(within(activity).getAllByRole('listitem')).toHaveLength(50)
    expect(activity).toHaveTextContent('3 earlier tool calls are not shown.')
  })

  it('omits both sections when the subagent reported nothing', () => {
    render(
      <SubagentDetailsDialog
        toolCall={delegatedCall}
        open
        onOpenChange={() => {}}
        filePathContext={undefined}
      />
    )
    expect(screen.queryByTestId('subagent-activity')).toBeNull()
    expect(screen.queryByTestId('subagent-output')).toBeNull()
  })
})

describe('SubagentDetailsDialog file-path open', () => {
  const completedCall: ToolCall = {
    ...delegatedCall,
    status: 'completed',
    rawOutput: { text: 'Edited src/foo.ts as asked.' }
  }

  function ClosableDialog({
    onOpenChange
  }: {
    onOpenChange: (open: boolean) => void
  }): React.JSX.Element {
    const [open, setOpen] = useState(true)
    return (
      <SubagentDetailsDialog
        toolCall={completedCall}
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next)
          setOpen(next)
        }}
        filePathContext={{ cwd: '/proj', projectRoot: '/proj' }}
      />
    )
  }

  let cleanup: () => void

  beforeEach(() => {
    window.history.replaceState(null, '', '#/base')
    cleanup = armMobileOverlayBackStack()
    useOverlayStackStore.getState().setMobileShell(false)
    openFilePathMock.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('closes the dialog when a file path opens in the editor', async () => {
    const onOpenChange = vi.fn()
    render(<ClosableDialog onOpenChange={onOpenChange} />)

    fireEvent.click(screen.getByTestId('termul-file-path'))

    expect(openFilePathMock).toHaveBeenCalledWith('src/foo.ts', {
      cwd: '/proj',
      projectRoot: '/proj'
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('consumes the mobile back-stack sentinel when a file opens', async () => {
    useOverlayStackStore.getState().setMobileShell(true)
    render(<ClosableDialog onOpenChange={() => {}} />)
    await waitForSentinelDepth(1)

    fireEvent.click(screen.getByTestId('termul-file-path'))

    await waitForSentinelDepth(0)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('stays open on a shift-click the file button ignores', () => {
    const onOpenChange = vi.fn()
    render(<ClosableDialog onOpenChange={onOpenChange} />)

    fireEvent.click(screen.getByTestId('termul-file-path'), { shiftKey: true })

    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
