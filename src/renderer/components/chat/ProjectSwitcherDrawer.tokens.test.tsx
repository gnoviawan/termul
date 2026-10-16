import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Story 12 (QA F12): ProjectSwitcherDrawer copy/width contract —
//   - drawer width ~70-75% viewport (w-[72vw] capped at 20rem)
//   - header p-2 family (no px-4 py-3 drift)
//   - no "desktop" wording in the accessible description

const { projectState } = vi.hoisted(() => ({
  projectState: {
    projects: [
      { id: 'p1', name: 'Alpha', path: '/a', color: 'blue' },
      { id: 'p3', name: 'Gamma', path: '/g', color: 'cyan' }
    ],
    activeProjectId: 'p1',
    selectProject: vi.fn()
  }
}))

vi.mock('@/hooks/use-project-switch', () => ({
  useProjectSwitch: () => ({ switchTo: vi.fn() })
}))

vi.mock('@/stores/project-store', () => ({
  useProjectStore: Object.assign((selector: (s: unknown) => unknown) => selector(projectState), {
    getState: () => projectState
  })
}))

vi.mock('@/lib/project-registry-api', () => ({
  projectRegistryApi: { setDefault: vi.fn() }
}))

import { ProjectSwitcherDrawer } from './ProjectSwitcherDrawer'

describe('ProjectSwitcherDrawer token sweep (story 12)', () => {
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
    expect(srOnly?.textContent).toBe(
      "Switch the session to another project or open the current project's settings"
    )
    expect(srOnly?.textContent?.toLowerCase()).not.toContain('desktop')
  })
})
