import type { GitCommit } from '@shared/types/ipc.types'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getLog } = vi.hoisted(() => ({ getLog: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))
vi.mock('@/lib/git-api', () => ({ gitApi: { getLog } }))

import { GIT_LOG_LIMIT, useGitHistoryStore } from '@/stores/git-history-store'
import { useGitStatusStore } from '@/stores/git-status-store'
import { findPaneContainingTab, gitHistoryTabId, useWorkspaceStore } from '@/stores/workspace-store'
import { HistoryRow } from './HistoryRow'

const CWD = '/work'

function commit(subject: string, hash: string): GitCommit {
  return {
    hash: hash.padEnd(40, '0'),
    shortHash: hash,
    parents: [],
    refs: [],
    author: 'Ada',
    date: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    subject
  }
}

describe('HistoryRow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getLog.mockResolvedValue([])
    useGitHistoryStore.setState({
      commits: {},
      loading: {},
      error: {},
      scope: {},
      details: {},
      headSummary: {}
    })
    useGitStatusStore.setState({ commitContexts: {} })
    const tabId = gitHistoryTabId(CWD)
    const pane = findPaneContainingTab(useWorkspaceStore.getState().root, tabId)
    if (pane) useWorkspaceStore.getState().removeTab(tabId)
  })

  it('shows the HEAD commit and the count from a HEAD-scoped read', async () => {
    getLog.mockResolvedValue([commit('Close the plan', 'a1b2c3d'), commit('Init', 'b2c3d4e')])
    render(<HistoryRow cwd={CWD} isVisible />)

    expect(await screen.findByText('2 commits')).toBeInTheDocument()
    expect(screen.getByText(/^Close the plan · /)).toBeInTheDocument()
    expect(getLog).toHaveBeenCalledWith(CWD, GIT_LOG_LIMIT, false)
  })

  it('ignores the History tab scope and its commit list', async () => {
    useGitHistoryStore.setState({
      scope: { [CWD]: 'all' },
      commits: { [CWD]: [commit('On another branch', 'f0f0f0f')] }
    })
    getLog.mockResolvedValue([commit('On HEAD', 'a1b2c3d')])
    render(<HistoryRow cwd={CWD} isVisible />)

    expect(await screen.findByText(/^On HEAD · /)).toBeInTheDocument()
    expect(screen.queryByText(/On another branch/)).toBeNull()
    expect(useGitHistoryStore.getState().scope[CWD]).toBe('all')
    expect(useGitHistoryStore.getState().loading[CWD]).toBeUndefined()
  })

  it('adds a plus when the history reaches the read limit', async () => {
    getLog.mockResolvedValue(
      Array.from({ length: GIT_LOG_LIMIT }, (_, i) => commit(`c${i}`, `c${i}`.padEnd(7, '0')))
    )
    render(<HistoryRow cwd={CWD} isVisible />)

    expect(await screen.findByText(`${GIT_LOG_LIMIT}+ commits`)).toBeInTheDocument()
  })

  it('loads only when visible and reloads when the commit context changes', async () => {
    getLog.mockResolvedValue([commit('First', 'a1b2c3d')])
    const { rerender } = render(<HistoryRow cwd={CWD} isVisible={false} />)
    expect(getLog).not.toHaveBeenCalled()
    rerender(<HistoryRow cwd={CWD} isVisible />)
    expect(await screen.findByText(/^First · /)).toBeInTheDocument()
    expect(getLog).toHaveBeenCalledTimes(1)

    getLog.mockResolvedValue([commit('Second', 'b2c3d4e'), commit('First', 'a1b2c3d')])
    await act(async () => {
      useGitStatusStore.setState({
        commitContexts: {
          [CWD]: {
            branch: 'main',
            hasUpstream: false,
            ahead: 1,
            behind: 0,
            stagedCount: 0,
            hasHead: true,
            lastSubject: 'Second',
            lastBody: ''
          }
        }
      })
    })
    expect(await screen.findByText(/^Second · /)).toBeInTheDocument()
    expect(screen.getByText('2 commits')).toBeInTheDocument()
    expect(getLog).toHaveBeenCalledTimes(2)
  })

  it('settles to No commits yet when the read fails', async () => {
    getLog.mockRejectedValue(new Error('not a git repository'))
    render(<HistoryRow cwd={CWD} isVisible />)

    expect(await screen.findByText('No commits yet')).toBeInTheDocument()
  })

  it('opens the Git History tab and then shows it as open', () => {
    getLog.mockResolvedValue([commit('Init', 'a1b2c3d')])
    render(<HistoryRow cwd={CWD} isVisible />)

    fireEvent.click(screen.getByRole('button', { name: 'Open History in the main panel' }))

    expect(
      findPaneContainingTab(useWorkspaceStore.getState().root, gitHistoryTabId(CWD))
    ).not.toBeNull()
    expect(
      screen.getByRole('button', { name: 'History, open in the main panel' })
    ).toBeInTheDocument()
  })
})
