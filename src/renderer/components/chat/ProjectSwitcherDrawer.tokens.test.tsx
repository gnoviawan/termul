import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Story 12 (QA F12): ProjectSwitcherDrawer copy/width contract —
//   - drawer width ~70-75% viewport (w-[72vw] capped at 20rem)
//   - header p-2 family (no px-4 py-3 drift)
//   - no "desktop" wording in the accessible description

const { mockSwitchProject, queuedRef, failedRef, setFailedProjectSwitch } = vi.hoisted(() => ({
  mockSwitchProject: vi.fn(),
  queuedRef: { current: null as string | null },
  failedRef: { current: null as string | null },
  setFailedProjectSwitch: vi.fn()
}))

vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (state: unknown) => unknown) =>
    selector({
      switchProject: mockSwitchProject,
      queuedProjectSwitchId: queuedRef.current,
      failedProjectSwitchId: failedRef.current,
      setFailedProjectSwitch
    })
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: (selector: (s: unknown) => unknown) =>
    selector({
      projects: [
        { id: 'p1', name: 'Alpha', path: '/a', color: 'blue' },
        { id: 'p3', name: 'Gamma', path: '/g', color: 'cyan' }
      ],
      activeProjectId: 'p1',
      selectProject: vi.fn()
    })
}))

vi.mock('@/lib/tauri-remote-api', () => ({
  setHostDefaultProject: vi.fn()
}))

vi.mock('@/lib/web-server-api', () => ({
  webServerProjects: vi.fn()
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => false
}))

import { ProjectSwitcherDrawer } from './ProjectSwitcherDrawer'

describe('ProjectSwitcherDrawer token sweep (story 12)', () => {
  beforeEach(() => {
    mockSwitchProject.mockReset()
    queuedRef.current = null
    failedRef.current = null
  })

  it('drawer width is ~70-75% of the viewport and the header uses the p-2 family', async () => {
    render(<ProjectSwitcherDrawer open onOpenChange={vi.fn()} />)

    const alpha = await screen.findByText('Alpha')
    const sheetContent = alpha.closest('[data-sheet]')
    expect(sheetContent).not.toBeNull()
    const cls = sheetContent?.className ?? ''
    expect(cls).toContain('w-[72vw]')
    expect(cls).toContain('max-w-20rem')
    expect(cls).not.toContain('100vw-3rem')

    const headerDiv = sheetContent?.querySelector('.border-b')
    expect(headerDiv).toBeTruthy()
    const headerCls = headerDiv?.className ?? ''
    expect(headerCls).toContain('p-2')
    expect(headerCls).not.toContain('px-4')
  })

  it('carries no desktop terminology in its accessible description', async () => {
    render(<ProjectSwitcherDrawer open onOpenChange={vi.fn()} />)

    await screen.findByText('Alpha')
    // The sr-only SheetDescription is the a11y text QA flagged.
    const srOnly = Array.from(document.querySelectorAll('.sr-only')).find((el) =>
      el.textContent?.toLowerCase().includes('project')
    )
    expect(srOnly?.textContent).toBe('Switch the session to another project')
    expect(srOnly?.textContent?.toLowerCase()).not.toContain('desktop')
  })
})
