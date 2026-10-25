import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resetSkillFileIndexCache } from '@/hooks/use-skill-file-index'
import { commandToken, skillToken } from '@/lib/skill-tokens'
import type { ChatMessage as ChatMessageType } from '@/stores/acp-store'
import { ChatMessage } from '../ChatMessage'
import { ChatComposerEditor } from '../composer/ChatComposerEditor'
import { CommandChipLink, SkillChipLink, SkillFilesProvider } from '../skill-file-links'

const { listSkillFilesRef, openFileRef, openFilesRef, addEditorTabRef, logRef, toastErrorRef } =
  vi.hoisted(() => ({
    listSkillFilesRef: { current: vi.fn() },
    openFileRef: { current: vi.fn() },
    openFilesRef: { current: new Set<string>() },
    addEditorTabRef: { current: vi.fn() },
    logRef: { current: vi.fn() },
    toastErrorRef: { current: vi.fn() }
  }))

vi.mock('@/lib/skills-api', () => ({
  skillsApi: { listSkillFiles: (root?: string) => listSkillFilesRef.current(root) }
}))

vi.mock('@/stores/editor-store', () => {
  const fn = vi.fn() as unknown as { getState: () => unknown }
  fn.getState = () => ({ openFile: openFileRef.current, openFiles: openFilesRef.current })
  return { useEditorStore: fn }
})

vi.mock('@/stores/workspace-store', () => {
  const fn = vi.fn() as unknown as { getState: () => unknown }
  fn.getState = () => ({ addEditorTab: addEditorTabRef.current })
  return { useWorkspaceStore: fn }
})

vi.mock('@/lib/log-api', () => ({
  logFrontendError: (payload: unknown) => logRef.current(payload)
}))

vi.mock('sonner', () => ({
  toast: { error: (message: string) => toastErrorRef.current(message) }
}))

const GLOBAL_SKILL = '/home/u/.agents/skills/forge-idea/SKILL.md'
const HARNESS_SKILL = '/home/u/.config/opencode/skills/oc-review/SKILL.md'

function userMessage(text: string): ChatMessageType {
  return {
    id: 'm1',
    role: 'user',
    blocks: [{ type: 'text', text }],
    streaming: false
  } as ChatMessageType
}

describe('skill file links', () => {
  beforeEach(() => {
    resetSkillFileIndexCache()
    listSkillFilesRef.current = vi.fn(async () => [
      { name: 'forge-idea', path: GLOBAL_SKILL },
      { name: 'OC-Review', path: HARNESS_SKILL }
    ])
    openFilesRef.current = new Set<string>()
    openFileRef.current = vi.fn(async (path: string) => {
      openFilesRef.current.add(path)
    })
    addEditorTabRef.current = vi.fn()
    logRef.current = vi.fn()
    toastErrorRef.current = vi.fn()
  })

  afterEach(() => {
    window.getSelection()?.removeAllRanges()
  })

  it('renders a static chip without a provider', () => {
    render(<SkillChipLink name="forge-idea" path={GLOBAL_SKILL} surface="bubble" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('forge-idea')).toBeTruthy()
    expect(listSkillFilesRef.current).not.toHaveBeenCalled()
  })

  it('opens the SKILL.md of a skill chip in an editor tab', async () => {
    render(
      <SkillFilesProvider projectRoot="/work/app">
        <SkillChipLink name="forge-idea" surface="bubble" />
      </SkillFilesProvider>
    )
    const button = await screen.findByRole('button', { name: 'Open skill forge-idea' })
    expect(listSkillFilesRef.current).toHaveBeenCalledWith('/work/app')

    await act(async () => {
      fireEvent.click(button)
    })

    expect(openFileRef.current).toHaveBeenCalledWith(GLOBAL_SKILL)
    expect(addEditorTabRef.current).toHaveBeenCalledWith(GLOBAL_SKILL)
  })

  it('makes a skill-backed command clickable, case-insensitively and via skill:<name>', async () => {
    render(
      <SkillFilesProvider projectRoot="/work/app">
        <CommandChipLink name="oc-review" surface="bubble" />
        <CommandChipLink name="skill:forge-idea" surface="bubble" />
        <CommandChipLink name="compact" surface="bubble" />
      </SkillFilesProvider>
    )
    const review = await screen.findByRole('button', { name: 'Open skill oc-review' })
    const promoted = screen.getByRole('button', { name: 'Open skill skill:forge-idea' })
    expect(screen.getByText('/compact').closest('button')).toBeNull()

    await act(async () => {
      fireEvent.click(review)
    })
    expect(openFileRef.current).toHaveBeenLastCalledWith(HARNESS_SKILL)

    await act(async () => {
      fireEvent.click(promoted)
    })
    expect(openFileRef.current).toHaveBeenLastCalledWith(GLOBAL_SKILL)
  })

  it('prefers the pick-time path over the index', async () => {
    const picked = '/work/app/.agents/skills/forge-idea/SKILL.md'
    render(
      <SkillFilesProvider projectRoot="/work/app">
        <SkillChipLink name="forge-idea" path={picked} surface="composer" />
      </SkillFilesProvider>
    )
    const button = screen.getByRole('button', { name: 'Open skill forge-idea' })
    expect(button.getAttribute('tabindex')).toBe('-1')

    await act(async () => {
      fireEvent.click(button)
    })
    expect(openFileRef.current).toHaveBeenCalledWith(picked)
  })

  it('does not open from a bubble click that ends a text selection', async () => {
    render(
      <SkillFilesProvider projectRoot="/work/app">
        <p>selected text</p>
        <SkillChipLink name="forge-idea" surface="bubble" />
      </SkillFilesProvider>
    )
    const button = await screen.findByRole('button', { name: 'Open skill forge-idea' })
    const range = document.createRange()
    range.setStart(screen.getByText('selected text').firstChild as Text, 0)
    range.setEndAfter(button)
    window.getSelection()?.addRange(range)

    fireEvent.click(button)

    expect(openFileRef.current).not.toHaveBeenCalled()
  })

  it('opens from a bubble click while text elsewhere or an empty range is selected', async () => {
    render(
      <SkillFilesProvider projectRoot="/work/app">
        <p>other text</p>
        <div data-testid="empty-composer">
          <p />
        </div>
        <SkillChipLink name="forge-idea" surface="bubble" />
      </SkillFilesProvider>
    )
    const button = await screen.findByRole('button', { name: 'Open skill forge-idea' })

    const elsewhere = document.createRange()
    elsewhere.selectNodeContents(screen.getByText('other text'))
    window.getSelection()?.addRange(elsewhere)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(openFileRef.current).toHaveBeenCalledTimes(1)

    window.getSelection()?.removeAllRanges()
    const empty = document.createRange()
    empty.selectNodeContents(screen.getByTestId('empty-composer'))
    window.getSelection()?.addRange(empty)
    await act(async () => {
      fireEvent.click(button)
    })
    expect(openFileRef.current).toHaveBeenCalledTimes(2)
  })

  it('toasts and logs when the editor cannot open the file', async () => {
    openFileRef.current = vi.fn(async () => {
      throw new Error('permission denied')
    })
    render(
      <SkillFilesProvider projectRoot="/work/app">
        <SkillChipLink name="forge-idea" surface="bubble" />
      </SkillFilesProvider>
    )
    const button = await screen.findByRole('button', { name: 'Open skill forge-idea' })

    await act(async () => {
      fireEvent.click(button)
    })

    expect(addEditorTabRef.current).not.toHaveBeenCalled()
    expect(toastErrorRef.current).toHaveBeenCalledWith('Could not open SKILL.md for forge-idea')
    expect(logRef.current).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'SkillFileLinks' })
    )
  })

  it('makes skill and command chips in a user bubble clickable', async () => {
    const text = `${commandToken('oc-review')} use ${skillToken('forge-idea')} and ${skillToken('unknown-skill')}`
    render(
      <TooltipProvider>
        <SkillFilesProvider projectRoot="/work/app">
          <ChatMessage message={userMessage(text)} animateEnter={false} />
        </SkillFilesProvider>
      </TooltipProvider>
    )

    const skill = await screen.findByRole('button', { name: 'Open skill forge-idea' })
    expect(screen.getByRole('button', { name: 'Open skill oc-review' })).toBeTruthy()
    expect(screen.getByText('unknown-skill').closest('button')).toBeNull()

    await act(async () => {
      fireEvent.click(skill)
    })
    expect(openFileRef.current).toHaveBeenCalledWith(GLOBAL_SKILL)
    expect(addEditorTabRef.current).toHaveBeenCalledWith(GLOBAL_SKILL)
  })

  it('makes skill and command pills in the composer clickable', async () => {
    render(
      <SkillFilesProvider projectRoot="/work/app">
        <ChatComposerEditor
          value={`${commandToken('oc-review')} ${skillToken('forge-idea')} `}
          onValueChange={vi.fn()}
          ariaLabel="Test composer"
        />
      </SkillFilesProvider>
    )

    const pill = await screen.findByRole('button', { name: 'Open skill forge-idea' })
    const command = screen.getByRole('button', { name: 'Open skill oc-review' })

    await act(async () => {
      fireEvent.click(command)
    })
    expect(openFileRef.current).toHaveBeenLastCalledWith(HARNESS_SKILL)

    await act(async () => {
      fireEvent.click(pill)
    })
    await waitFor(() => expect(addEditorTabRef.current).toHaveBeenLastCalledWith(GLOBAL_SKILL))
  })
})
