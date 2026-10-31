import wire from '@shared/types/__fixtures__/automation.json'
import type { AutomationSuggestion } from '@shared/types/automation.types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSuggestionList } from '@/lib/automation-wire'

const api = vi.hoisted(() => ({
  acceptAutomationSuggestion: vi.fn(),
  dismissAutomationSuggestion: vi.fn(),
  listAutomationSuggestions: vi.fn(),
  matchAutomationSuggestion: vi.fn(),
  onAutomationChanged: vi.fn(() => () => {})
}))
const launch = vi.hoisted(() => ({ launchSuggestionChat: vi.fn(async () => true) }))
vi.mock('@/lib/automation-api', () => api)
vi.mock('@/lib/automation-suggestion-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/automation-suggestion-launch')>()),
  launchSuggestionChat: launch.launchSuggestionChat
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { suggestionPrompt } from '@/lib/automation-suggestion-launch'
import { useAcpStore } from '@/stores/acp-store'
import { useAppSettingsStore } from '@/stores/app-settings-store'
import { DEFAULT_APP_SETTINGS } from '@/types/settings'
import { ChatAutomationSuggestion } from './ChatAutomationSuggestion'
import { SuggestedAutomations } from './SuggestedAutomations'
import { SNOOZE_MS, useSuggestionSnoozes } from './suggestion-snooze'
import { resetOfferedChatsForTests } from './use-chat-automation-suggestion'

const [SUGGESTION] = parseSuggestionList([wire.suggestion]) as [AutomationSuggestion]
const COPY =
  "You've asked something like “summarize the open PRs in termul” on 4 days " +
  '(usually weekdays at 09:00). Make it a background automation?'
const ok = <T,>(data: T) => Promise.resolve({ success: true as const, data })

function setSuggest(on: boolean): void {
  useAppSettingsStore.setState({ settings: { ...DEFAULT_APP_SETTINGS, suggestAutomations: on } })
}

function sendInChat(sessionId: string, text: string): void {
  act(() => {
    useAcpStore.setState((s) => ({
      messages: {
        ...s.messages,
        [sessionId]: [
          {
            id: `m-${text.length}`,
            role: 'user',
            blocks: [{ type: 'text', text }],
            streaming: false,
            timestamp: Date.now()
          }
        ]
      }
    }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useSuggestionSnoozes.setState({ until: {} })
  useAcpStore.setState({ messages: {} })
  resetOfferedChatsForTests()
  setSuggest(true)
  api.listAutomationSuggestions.mockImplementation(() => ok([SUGGESTION]))
  api.matchAutomationSuggestion.mockImplementation(() => ok(SUGGESTION))
  api.acceptAutomationSuggestion.mockImplementation(() => ok(undefined))
  api.dismissAutomationSuggestion.mockImplementation(() => ok(undefined))
})

describe('the in-chat suggestion card', () => {
  it('matches the prompt the user just sent and offers to schedule it', async () => {
    render(<ChatAutomationSuggestion sessionId="s1" projectId="p1" />)
    expect(screen.queryByTestId('automation-suggestion-card')).toBeNull()

    sendInChat('s1', 'summarize the open PRs in termul')

    expect(await screen.findByText(COPY)).toBeTruthy()
    expect(api.matchAutomationSuggestion).toHaveBeenCalledWith(
      'p1',
      'summarize the open PRs in termul'
    )
  })

  it('creates: opens the seeded chat, then accepts the suggestion', async () => {
    render(<ChatAutomationSuggestion sessionId="s1" projectId="p1" />)
    sendInChat('s1', 'summarize the open PRs in termul')

    fireEvent.click(await screen.findByRole('button', { name: 'Create automation' }))

    await waitFor(() => expect(screen.queryByTestId('automation-suggestion-card')).toBeNull())
    expect(launch.launchSuggestionChat).toHaveBeenCalledWith('p1', SUGGESTION)
    expect(api.acceptAutomationSuggestion).toHaveBeenCalledWith('p1', '3f1c9a0d5b7e2468')
  })

  it('create: a launch that fails keeps the suggestion open and unanswered', async () => {
    launch.launchSuggestionChat.mockResolvedValueOnce(false)
    render(<ChatAutomationSuggestion sessionId="s1" projectId="p1" />)
    sendInChat('s1', 'summarize the open PRs in termul')

    fireEvent.click(await screen.findByRole('button', { name: 'Create automation' }))

    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Create automation' }) as HTMLButtonElement).disabled
      ).toBe(false)
    )
    expect(launch.launchSuggestionChat).toHaveBeenCalledTimes(1)
    expect(api.acceptAutomationSuggestion).not.toHaveBeenCalled()
    expect(screen.getByText(COPY)).toBeTruthy()
  })

  it("don't suggest: dismisses it on the host", async () => {
    render(<ChatAutomationSuggestion sessionId="s1" projectId="p1" />)
    sendInChat('s1', 'summarize the open PRs in termul')

    fireEvent.click(await screen.findByRole('button', { name: "Don't suggest this again" }))

    await waitFor(() => expect(screen.queryByTestId('automation-suggestion-card')).toBeNull())
    expect(api.dismissAutomationSuggestion).toHaveBeenCalledWith('p1', '3f1c9a0d5b7e2468')
  })

  it('not now: hides it on this device for 24 hours without telling the host', async () => {
    render(<ChatAutomationSuggestion sessionId="s1" projectId="p1" />)
    sendInChat('s1', 'summarize the open PRs in termul')
    const before = Date.now()

    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))

    expect(screen.queryByTestId('automation-suggestion-card')).toBeNull()
    const stored = JSON.parse(localStorage.getItem('termul.automation-suggestion-snoozes') ?? '{}')
    expect(stored['p1:3f1c9a0d5b7e2468']).toBeGreaterThanOrEqual(before + SNOOZE_MS)
    expect(api.dismissAutomationSuggestion).not.toHaveBeenCalled()
    expect(api.acceptAutomationSuggestion).not.toHaveBeenCalled()
  })

  it('shows at most one card per chat', async () => {
    render(<ChatAutomationSuggestion sessionId="s1" projectId="p1" />)
    sendInChat('s1', 'summarize the open PRs in termul')
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }))
    useSuggestionSnoozes.setState({ until: {} })

    sendInChat('s1', 'summarize the open PRs in termul again')

    await act(async () => {})
    expect(api.matchAutomationSuggestion).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('automation-suggestion-card')).toBeNull()
  })

  it('asks once when a launch swaps the chat to its real session id', async () => {
    const { rerender } = render(<ChatAutomationSuggestion sessionId="placeholder" projectId="p1" />)
    sendInChat('placeholder', 'summarize the open PRs in termul')
    expect(await screen.findByText(COPY)).toBeTruthy()

    sendInChat('real', 'summarize the open PRs in termul.')
    rerender(<ChatAutomationSuggestion sessionId="real" projectId="p1" />)

    await act(async () => {})
    expect(api.matchAutomationSuggestion).toHaveBeenCalledTimes(1)
    expect(screen.getByText(COPY)).toBeTruthy()
  })

  it('with the setting off, never asks the host and shows nothing', async () => {
    setSuggest(false)
    render(<ChatAutomationSuggestion sessionId="s1" projectId="p1" />)

    sendInChat('s1', 'summarize the open PRs in termul')

    await act(async () => {})
    expect(api.matchAutomationSuggestion).not.toHaveBeenCalled()
    expect(screen.queryByTestId('automation-suggestion-card')).toBeNull()
  })

  it('does not match history that loads into the chat', async () => {
    render(<ChatAutomationSuggestion sessionId="s1" projectId="p1" />)

    act(() => {
      useAcpStore.setState({
        messages: {
          s1: [
            {
              id: 'old',
              role: 'user',
              blocks: [{ type: 'text', text: 'summarize the open PRs in termul' }],
              streaming: false,
              timestamp: Date.now() - 60 * 60 * 1000
            }
          ]
        }
      })
    })

    await act(async () => {})
    expect(api.matchAutomationSuggestion).not.toHaveBeenCalled()
  })
})

describe('the Suggested section', () => {
  it('lists open suggestions with the same answers', async () => {
    render(<SuggestedAutomations projectId="p1" />)

    expect(await screen.findByText(COPY)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Suggested' })).toBeTruthy()
    expect(api.listAutomationSuggestions).toHaveBeenCalledWith('p1')

    fireEvent.click(screen.getByRole('button', { name: "Don't suggest this again" }))
    await waitFor(() =>
      expect(api.dismissAutomationSuggestion).toHaveBeenCalledWith('p1', '3f1c9a0d5b7e2468')
    )
  })

  it('hides a snoozed suggestion', async () => {
    useSuggestionSnoozes.getState().snooze('p1', '3f1c9a0d5b7e2468')
    render(<SuggestedAutomations projectId="p1" />)

    await waitFor(() => expect(api.listAutomationSuggestions).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('automation-suggestion-card')).toBeNull()
  })

  it('a snooze in one project does not hide the same ask in another', async () => {
    useSuggestionSnoozes.getState().snooze('p1', '3f1c9a0d5b7e2468')
    render(<SuggestedAutomations projectId="p2" />)

    expect(await screen.findByText(COPY)).toBeTruthy()
  })

  it('shows a snoozed suggestion again when the snooze ends with the panel open', async () => {
    useSuggestionSnoozes.getState().snooze('p1', '3f1c9a0d5b7e2468', Date.now() - SNOOZE_MS + 100)
    render(<SuggestedAutomations projectId="p1" />)
    await waitFor(() => expect(api.listAutomationSuggestions).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('automation-suggestion-card')).toBeNull()

    expect(await screen.findByText(COPY)).toBeTruthy()
    expect(api.listAutomationSuggestions).toHaveBeenCalledTimes(1)
  })

  it('with the setting off, is not loaded or shown', async () => {
    setSuggest(false)
    render(<SuggestedAutomations projectId="p1" />)

    await act(async () => {})
    expect(api.listAutomationSuggestions).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Suggested' })).toBeNull()
  })
})

describe('the seeded chat prompt', () => {
  it('names the ask, its days and cadence, and the way to build it', () => {
    expect(suggestionPrompt(SUGGESTION)).toBe(
      'Turn this repeated request into a scheduled background automation: ' +
        "«summarize the open PRs in termul». I've asked it on 4 days, usually weekdays at 09:00. " +
        'Ask me at most 3 questions with your question tool (schedule, where results go), ' +
        'then build it with the automation tools and propose it.'
    )
  })
})
