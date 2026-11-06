import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { type CompletionContext, CompletionScheduler } from '@/lib/command-lifecycle/completion'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import { AppearanceSection } from './appearance-section'

afterEach(() => {
  vi.useRealTimers()
})

it('refresh defaults on', () => {
  expect(DEFAULT_APP_SETTINGS.automaticCompletionRefresh).toBe(true)
})

it('describes an immediate effect, not a new-terminal-only one', () => {
  // The scheduler reads the setting live per request (bind-session passes a
  // getter over the store), so the copy must not claim new-terminals-only.
  render(
    <AppearanceSection
      fontSize={14}
      bufferSize={10000}
      terminalRenderer="auto"
      screenReaderMode={false}
      terminalUrlOpenMode="system"
      handleFontSizeChange={vi.fn()}
      handleBufferSizeChange={vi.fn()}
      handleRendererChange={vi.fn()}
      handleScreenReaderModeChange={vi.fn()}
      handleTerminalUrlOpenModeChange={vi.fn()}
      automaticCompletionRefresh={true}
      handleAutomaticCompletionRefreshChange={vi.fn()}
    />
  )

  const row = within(document.getElementById('terminal-automatic-completion-refresh-description')!)
  expect(row.getByText(/Applies immediately/)).toBeTruthy()
  expect(row.queryByText(/new terminals/)).toBeNull()
})

it('appearance switch renders on', () => {
  const onChange = vi.fn()
  render(
    <AppearanceSection
      fontSize={14}
      bufferSize={10000}
      terminalRenderer="auto"
      screenReaderMode={false}
      terminalUrlOpenMode="system"
      handleFontSizeChange={vi.fn()}
      handleBufferSizeChange={vi.fn()}
      handleRendererChange={vi.fn()}
      handleScreenReaderModeChange={vi.fn()}
      handleTerminalUrlOpenModeChange={vi.fn()}
      automaticCompletionRefresh={true}
      handleAutomaticCompletionRefreshChange={onChange}
    />
  )

  const toggle = screen.getByRole('switch', { name: 'Automatic completion refresh' })
  expect(toggle).toHaveAttribute('aria-checked', 'true')

  fireEvent.click(toggle)
  expect(onChange).toHaveBeenCalledWith(false)
})

it('scheduler reads the setting', async () => {
  vi.useFakeTimers()
  const requests: unknown[] = []
  const host = {
    requestCompletion(_terminalId: string, request: unknown) {
      requests.push(request)
      return new Promise(() => {})
    },
    cancelCompletion() {
      return Promise.resolve('Accepted' as const)
    }
  }
  const clock = {
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)
  }
  const settings = { automaticCompletionRefresh: false }
  const scheduler = new CompletionScheduler({
    host,
    createRequestId: () => 'A',
    settings,
    clock
  })
  const context: CompletionContext = {
    terminalId: 't1',
    sessionId: 's1',
    mode: 'Editor',
    phase: 'AtPrompt',
    draft: 'git sta',
    bufferRevision: 4,
    cursor: 7,
    promptGeneration: 3,
    cwd: '/repo'
  }

  scheduler.updateContext(context)
  await vi.advanceTimersByTimeAsync(100)

  expect(requests).toHaveLength(0)
})
