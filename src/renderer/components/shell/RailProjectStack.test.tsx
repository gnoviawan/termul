import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectRowStatus } from '@/components/sidebar/indicators'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useProjectStore } from '@/stores/project-store'
import type { Project, ProjectGroup } from '@/types/project'
import { RAIL_STACK_OTHERS, RailProjectStack } from './RailProjectStack'

const { statusRef, openProject } = vi.hoisted(() => ({
  statusRef: { current: {} as Record<string, Partial<ProjectRowStatus>> },
  openProject: vi.fn()
}))

vi.mock('@/components/sidebar/use-project-rail', () => ({
  useProjectRail: () => ({
    status: (id: string) => ({
      live: null,
      attentionCount: 0,
      crashed: false,
      ...statusRef.current[id]
    }),
    openProject,
    openNeedsYou: vi.fn()
  })
}))

const project = (id: string, extra: Partial<Project> = {}): Project =>
  ({ id, name: id.toUpperCase(), color: 'blue', path: `/repo/${id}`, ...extra }) as Project

const ids = (...list: string[]): Project[] => list.map((id) => project(id))
const many = ids('a', 'b', 'c', 'd', 'e', 'f', 'g')

function stackView(projects: Project[], activeId = 'a') {
  return (
    <MemoryRouter>
      <TooltipProvider>
        <RailProjectStack
          projects={projects}
          activeProject={projects.find((p) => p.id === activeId)}
          onSelectProject={vi.fn()}
          onNewProject={vi.fn()}
        />
      </TooltipProvider>
    </MemoryRouter>
  )
}

function stackNames(): (string | null)[] {
  return within(screen.getByTestId('rail-project-stack'))
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label'))
}

function renderStack(projects: Project[], activeId = 'a') {
  const view = render(stackView(projects, activeId))
  return {
    names: stackNames(),
    rerenderStack: () => view.rerender(stackView(projects, activeId))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  statusRef.current = {}
  useProjectStore.setState({ groups: [] })
})

describe('RailProjectStack', () => {
  it('puts the active project first on the keycap, then the other open projects', () => {
    const { names } = renderStack([...ids('a', 'b'), project('z', { isArchived: true })])
    expect(names).toEqual(['Switch project (A)', 'Open B'])
    expect(screen.getByRole('button', { name: 'Switch project (A)' })).toHaveClass('keycap')
  })

  it('opens the project from an icon, as the main click of an expanded row', () => {
    renderStack(ids('a', 'b'))
    fireEvent.click(screen.getByRole('button', { name: 'Open B' }))
    expect(openProject).toHaveBeenCalledWith('b')
  })

  it('lists the others in the expanded Rail order: groups first, then ungrouped', () => {
    const groups: ProjectGroup[] = [
      { id: 'g1', name: 'One', projectIds: ['e', 'c'] },
      { id: 'g2', name: 'Two', projectIds: ['b'] }
    ]
    useProjectStore.setState({ groups })
    const { names } = renderStack(ids('a', 'b', 'c', 'd', 'e'))
    expect(names).toEqual(['Switch project (A)', 'Open E', 'Open C', 'Open B', 'Open D'])
  })

  it('lists the switcher popover in the same Rail order', () => {
    // cmdk scrolls the selected item into view; jsdom has no layout.
    Element.prototype.scrollIntoView = vi.fn()
    useProjectStore.setState({ groups: [{ id: 'g1', name: 'One', projectIds: ['c', 'b'] }] })
    renderStack(ids('a', 'b', 'c', 'd'))
    fireEvent.click(screen.getByRole('button', { name: 'Switch project (A)' }))
    const paths = screen.getAllByRole('option').map((option) => option.textContent)
    expect(paths.slice(0, 4).map((text) => text?.match(/\/repo\/(\w)/)?.[1])).toEqual([
      'c',
      'b',
      'a',
      'd'
    ])
  })

  it('keeps list order when statuses change, so no icon moves under the pointer', () => {
    const { names: before, rerenderStack } = renderStack(ids('a', 'b', 'c', 'd', 'e'))
    expect(before).toEqual(['Switch project (A)', 'Open B', 'Open C', 'Open D', 'Open E'])

    statusRef.current = {
      c: { live: 'activity' },
      d: { crashed: true },
      e: { attentionCount: 2 }
    }
    rerenderStack()
    expect(stackNames()).toEqual(before)
  })

  it('names a status in the description, not in the name', () => {
    statusRef.current = { c: { live: 'activity' }, d: { crashed: true }, e: { attentionCount: 2 } }
    renderStack(ids('a', 'b', 'c', 'd', 'e'))
    expect(screen.getByRole('button', { name: 'Open B' })).not.toHaveAccessibleDescription()
    expect(screen.getByRole('button', { name: 'Open C' })).toHaveAccessibleDescription('Running')
    expect(screen.getByRole('button', { name: 'Open D' })).toHaveAccessibleDescription(
      'Terminal crashed'
    )
    expect(screen.getByRole('button', { name: 'Open E' })).toHaveAccessibleDescription('2 need you')
  })

  it(`shows ${RAIL_STACK_OTHERS} others and puts the rest behind "+N"`, () => {
    const { names } = renderStack(many)
    expect(names).toEqual([
      'Switch project (A)',
      'Open B',
      'Open C',
      'Open D',
      'Open E',
      '2 more projects'
    ])
    expect(screen.getByRole('button', { name: '2 more projects' })).toHaveTextContent('+2')
  })

  it('keeps a hidden project that needs you hidden, in list order', () => {
    statusRef.current = { g: { attentionCount: 1 } }
    const { names } = renderStack(many)
    expect(names).toEqual([
      'Switch project (A)',
      'Open B',
      'Open C',
      'Open D',
      'Open E',
      '2 more projects, 1 needs you'
    ])
  })

  describe('"+N" needs-you badge', () => {
    it('is absent when no hidden project needs you, even if a shown one does', () => {
      statusRef.current = { b: { attentionCount: 3 } }
      renderStack(many)
      const more = screen.getByRole('button', { name: '2 more projects' })
      expect(more).toHaveTextContent(/^\+2$/)
    })

    it('adds one combined count of the chats that need you in hidden projects', () => {
      statusRef.current = { f: { attentionCount: 2 }, g: { attentionCount: 1 } }
      renderStack(many)
      const more = screen.getByRole('button', { name: '2 more projects, 3 need you' })
      expect(within(more).getByText('+2')).toBeInTheDocument()
      expect(within(more).getByText('3')).toBeInTheDocument()
    })

    it('caps the count at 9+', () => {
      statusRef.current = { f: { attentionCount: 12 } }
      renderStack(many)
      const more = screen.getByRole('button', { name: '2 more projects, 12 need you' })
      expect(within(more).getByText('9+')).toBeInTheDocument()
    })
  })
})
