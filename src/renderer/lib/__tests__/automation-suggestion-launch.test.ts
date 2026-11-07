import wire from '@shared/types/__fixtures__/automation.json'
import type { AutomationSuggestion } from '@shared/types/automation.types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const write = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ persistenceApi: { write } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

import { launchSuggestionChat } from '@/lib/automation-suggestion-launch'
import { parseSuggestionList } from '@/lib/automation-wire'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

const [SUGGESTION] = parseSuggestionList([wire.suggestion]) as [AutomationSuggestion]

function project(path: string): void {
  useProjectStore.setState({
    projects: [{ id: 'p1', name: 'termul', path }] as never
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useAcpStore.setState({ agentConfigs: [], selectedAgentConfigId: null } as never)
})

describe('launchSuggestionChat', () => {
  it('without a project folder, reports no launch and opens nothing', async () => {
    project('')
    const showLauncher = vi.spyOn(useWorkspaceStore.getState(), 'showAgentLauncher')

    expect(await launchSuggestionChat('p1', SUGGESTION)).toBe(false)
    expect(write).not.toHaveBeenCalled()
    expect(showLauncher).not.toHaveBeenCalled()
  })

  it('without a default agent, reports a launch once the launcher draft is saved', async () => {
    project('/work/termul')
    write.mockResolvedValue({ success: true, data: undefined })

    expect(await launchSuggestionChat('p1', SUGGESTION)).toBe(true)
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('p1'),
      expect.stringContaining('«summarize the open PRs in termul»')
    )
  })

  it('reports no launch when the launcher draft cannot be saved', async () => {
    project('/work/termul')
    write.mockResolvedValue({ success: false, error: 'store offline', code: 'NETWORK_ERROR' })

    expect(await launchSuggestionChat('p1', SUGGESTION)).toBe(false)
  })
})
