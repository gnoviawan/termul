import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type ProjectBusyRequest, useProjectBusyStore } from '@/stores/project-busy-store'
import { describeBoundEntities, ProjectBusyDialog } from './ProjectBusyDialog'

function request(overrides: Partial<ProjectBusyRequest> = {}): ProjectBusyRequest {
  return {
    kind: 'delete',
    projectId: 'p1',
    projectName: 'Alpha',
    sessions: 2,
    terminals: 1,
    resend: vi.fn(async () => {}),
    ...overrides
  }
}

beforeEach(() => {
  useProjectBusyStore.setState({ requests: [], isResending: false })
})

describe('describeBoundEntities', () => {
  it('names only the kinds that are bound, in the singular or the plural', () => {
    expect(describeBoundEntities(2, 1)).toBe('2 chats and 1 terminal')
    expect(describeBoundEntities(1, 3)).toBe('1 chat and 3 terminals')
    expect(describeBoundEntities(1, 0)).toBe('1 chat')
    expect(describeBoundEntities(0, 2)).toBe('2 terminals')
  })
})

describe('ProjectBusyDialog', () => {
  it('shows nothing until the host refuses a delete or an archive', () => {
    render(<ProjectBusyDialog />)

    expect(screen.queryByRole('button', { name: /Stop and/ })).toBeNull()
  })

  it('says in plain English what is running and what confirming does', () => {
    useProjectBusyStore.getState().request(request())
    render(<ProjectBusyDialog />)

    expect(screen.getByText('Delete "Alpha"?')).toBeInTheDocument()
    expect(
      screen.getByText(/2 chats and 1 terminal are still running in this project/)
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop and delete' })).toBeInTheDocument()
  })

  it('words an archive and a folder change for what they do', () => {
    useProjectBusyStore.getState().request(request({ kind: 'archive', sessions: 1, terminals: 0 }))
    const { rerender } = render(<ProjectBusyDialog />)
    expect(screen.getByText('Archive "Alpha"?')).toBeInTheDocument()
    expect(screen.getByText(/1 chat is still running in this project/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop and archive' })).toBeInTheDocument()

    useProjectBusyStore.setState({
      requests: [request({ kind: 'move', sessions: 0, terminals: 2 })]
    })
    rerender(<ProjectBusyDialog />)
    expect(screen.getByText('Change the folder of "Alpha"?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop and change folder' })).toBeInTheDocument()
  })

  it('resends only after the user confirms', async () => {
    const pending = request()
    useProjectBusyStore.getState().request(pending)
    render(<ProjectBusyDialog />)
    expect(pending.resend).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Stop and delete' }))

    await waitFor(() => expect(pending.resend).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useProjectBusyStore.getState().requests).toEqual([]))
  })

  it('leaves the project alone when the user keeps it', () => {
    const pending = request()
    useProjectBusyStore.getState().request(pending)
    render(<ProjectBusyDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Keep project' }))

    expect(pending.resend).not.toHaveBeenCalled()
    expect(useProjectBusyStore.getState().requests).toEqual([])
  })

  it('asks about the next refused project after the first is answered', () => {
    useProjectBusyStore.getState().request(request({ projectId: 'p1', projectName: 'Alpha' }))
    useProjectBusyStore.getState().request(request({ projectId: 'p2', projectName: 'Beta' }))
    render(<ProjectBusyDialog />)
    expect(screen.getByText('Delete "Alpha"?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Keep project' }))

    expect(screen.getByText('Delete "Beta"?')).toBeInTheDocument()
  })
})
