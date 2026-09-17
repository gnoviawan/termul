import { fireEvent, type RenderResult, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Snapshot } from '@/types/project'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() }
}))

// Story 9 (QA repro): the Snapshots page rendered its desktop layout under
// the mobile shell — wrapping h1 with doubled project name, dual create CTAs,
// hover-only rename/delete with a dead Rename button. These tests pin the
// mobile branch: truncated single-line h1, one CTA, always-visible touch
// rename/delete wired to the server store, and desktop parity.

const { mobileRef, mocks } = vi.hoisted(() => ({
  // Mutable so desktop/mobile rows can flip the shell without re-mocking.
  mobileRef: { current: false as boolean },
  mocks: {
    loadSnapshots: vi.fn(),
    createSnapshot: vi.fn(),
    deleteSnapshot: vi.fn(),
    renameSnapshot: vi.fn(),
    snapshots: [] as Snapshot[]
  }
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current,
  MOBILE_WEB_SHELL_MAX_PX: 767
}))

vi.mock('@/hooks/use-snapshots', () => ({
  useSnapshotLoader: () => {},
  useCreateSnapshot: () => mocks.createSnapshot,
  useRenameSnapshot: () => mocks.renameSnapshot,
  useRestoreSnapshot: () => vi.fn(),
  useSnapshotActions: () => ({
    loadSnapshots: mocks.loadSnapshots,
    createSnapshot: mocks.createSnapshot,
    deleteSnapshot: mocks.deleteSnapshot,
    getSnapshot: vi.fn(),
    clearSnapshots: vi.fn(),
    renameSnapshot: mocks.renameSnapshot
  }),
  useSnapshotLoading: () => false,
  useSnapshots: () => mocks.snapshots
}))

vi.mock('@/stores/project-store', () => ({
  useActiveProject: () => ({
    id: 'proj-1',
    name: 'My Project',
    color: 'blue' as const
  }),
  useActiveProjectId: () => 'proj-1',
  useProjectsLoaded: () => true,
  useProjectActions: () => ({ addProject: vi.fn() })
}))

vi.mock('@/stores/terminal-store', () => ({
  useTerminalStore: (selector: (state: { terminals: unknown[] }) => unknown) =>
    selector({ terminals: [] })
}))

vi.mock('@/components/CreateSnapshotModal', () => ({
  CreateSnapshotModal: () => <div data-testid="create-snapshot-modal" />
}))
vi.mock('@/components/RestoreSnapshotModal', () => ({
  RestoreSnapshotModal: () => <div data-testid="restore-snapshot-modal" />
}))
vi.mock('@/components/DeleteSnapshotModal', () => ({
  // Story 9 row 4: delete must open the existing confirm modal. The mock
  // records the open prop so the test can assert the page wired onDelete.
  DeleteSnapshotModal: ({ snapshot }: { snapshot: Snapshot | null }) => (
    <div data-testid="delete-snapshot-modal" data-open={snapshot ? 'true' : 'false'} />
  )
}))
vi.mock('@/components/NewProjectModal', () => ({ NewProjectModal: () => null }))

import WorkspaceSnapshots from './WorkspaceSnapshots'

const buildSnapshot = (id: string, name: string): Snapshot => ({
  id,
  projectId: 'proj-1',
  name,
  description: `${name} description`,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  paneCount: 2,
  processCount: 1,
  tag: 'base'
})

function renderPage(): RenderResult {
  return render(
    <MemoryRouter>
      <WorkspaceSnapshots />
    </MemoryRouter>
  )
}

const findCreateCtas = (): HTMLElement[] =>
  screen.getAllByRole('button').filter((b) => /create|new/i.test(b.textContent ?? ''))

describe('WorkspaceSnapshots mobile branch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mobileRef.current = true
    mocks.snapshots = []
  })

  afterEach(() => {
    mocks.snapshots = []
    mobileRef.current = false
  })

  it('renders a truncated single-line h1 with no doubled project name and exactly one create CTA (390px row)', () => {
    mocks.snapshots = [buildSnapshot('snap-1', 'Only Snapshot')]

    const { container } = renderPage()

    const h1 = container.querySelector('h1')
    expect(h1).not.toBeNull()
    // Single text child: page title only — the mobile shell header already
    // shows the project name, so the page h1 must not double it.
    expect(h1?.textContent).toBe('Workspace Snapshots')
    // Truncation contract: the text sits inside a single truncate span —
    // single line, no mid-word wrap, no doubled project name segments.
    expect(h1?.querySelector('span.truncate')).not.toBeNull()
    expect(h1?.querySelectorAll('span.truncate')).toHaveLength(1)
    expect(h1?.className).toContain('min-w-0')

    // Exactly ONE create CTA when snapshots exist — header only.
    const ctas = findCreateCtas()
    expect(ctas).toHaveLength(1)

    // Mobile spacing rhythm: p-2 on the list, h-12 header.
    const header = container.querySelector('main > div')
    expect(header?.className).toContain('h-12')
    const listPane = container.querySelector('.bg-terminal-bg')
    expect(listPane?.className).toContain('p-2')
  })

  it('hides the header CTA on mobile when empty so the empty state carries the only CTA', () => {
    mocks.snapshots = []

    renderPage()

    expect(screen.getByText('No snapshots yet')).toBeInTheDocument()

    const ctas = findCreateCtas()
    expect(ctas).toHaveLength(1)
    // The single CTA lives in the empty state, not the header.
    expect(ctas[0]?.textContent).toMatch(/create first snapshot/i)
  })

  it('keeps rename and delete always visible (no hover gating) and touch-sized', () => {
    mocks.snapshots = [buildSnapshot('snap-1', 'Visible Actions')]

    const { container } = renderPage()

    const rename = screen.getByRole('button', { name: 'Rename snapshot' })
    const del = screen.getByRole('button', { name: 'Delete snapshot' })
    expect(rename).toBeVisible()
    expect(del).toBeVisible()

    // 44px floor via the `touch` button size (h-11 + hit-slop overlay).
    expect(rename.className).toContain('h-11')
    expect(del.className).toContain('h-11')

    // No opacity-0 hover gating anywhere in the mobile card.
    const mobileCard = rename.closest('div.rounded-lg') ?? container
    expect(mobileCard.querySelector('.opacity-0')).toBeNull()
  })

  it('opens an inline rename input, and confirming round-trips through renameSnapshot', async () => {
    mocks.snapshots = [buildSnapshot('snap-rename', 'Before Rename')]
    mocks.renameSnapshot.mockResolvedValue(undefined)

    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Rename snapshot' }))

    const input = await screen.findByLabelText('Rename snapshot')
    expect((input as HTMLInputElement).value).toBe('Before Rename')

    fireEvent.change(input, { target: { value: 'After Rename' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(mocks.renameSnapshot).toHaveBeenCalledTimes(1)
    })
    expect(mocks.renameSnapshot).toHaveBeenCalledWith('snap-rename', 'After Rename')
  })

  it('cancels the inline rename without touching the store on Escape', () => {
    mocks.snapshots = [buildSnapshot('snap-esc', 'Escape Me')]
    mocks.renameSnapshot.mockResolvedValue(undefined)

    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Rename snapshot' }))
    const input = screen.getByLabelText('Rename snapshot') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Never Persisted' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(mocks.renameSnapshot).not.toHaveBeenCalled()
    // Back to the read-only name display.
    expect(screen.getByText('Escape Me')).toBeInTheDocument()
  })

  it('surfaces a toast when the rename persist fails (rollback handled by the store)', async () => {
    mocks.snapshots = [buildSnapshot('snap-fail', 'Failure Case')]
    mocks.renameSnapshot.mockRejectedValue(new Error('persist failed'))

    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Rename snapshot' }))
    const input = screen.getByLabelText('Rename snapshot') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Doomed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Could not rename the snapshot. Try again.')
    })
  })

  it('delete is always visible and opens the existing delete confirm modal', () => {
    mocks.snapshots = [buildSnapshot('snap-del', 'Delete Me')]

    const { container } = renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Delete snapshot' }))

    const modal = container.querySelector('[data-testid="delete-snapshot-modal"]')
    expect(modal?.getAttribute('data-open')).toBe('true')
  })
})

describe('WorkspaceSnapshots desktop branch (parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mobileRef.current = false
    mocks.snapshots = [buildSnapshot('snap-desktop', 'Desktop Snapshot')]
  })

  afterEach(() => {
    mocks.snapshots = []
  })

  it('keeps the desktop header rhythm (h-14 px-6) and desktop hover-only actions', () => {
    const { container } = renderPage()

    // Desktop header spacing unchanged.
    const header = container.querySelector('main > div')
    expect(header?.className).toContain('h-14')
    expect(header?.className).toContain('px-6')
    const listPane = container.querySelector('.bg-terminal-bg')
    expect(listPane?.className).toContain('p-6')

    // Desktop h1 renders the full two-segment title (not the mobile
    // single-span truncation) and keeps the desktop create CTA label.
    const h1 = container.querySelector('h1')
    expect(h1?.textContent).toBe('My Project/Workspace Snapshots')
    expect(screen.getByText('Create New Snapshot')).toBeInTheDocument()

    // Desktop keeps hover-only (opacity-0 group-hover) actions.
    expect(container.querySelector('.opacity-0.group-hover\\:opacity-100')).not.toBeNull()
  })
})
