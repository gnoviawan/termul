import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Project } from '@/types/project'
import { ProjectSwitcher } from './ProjectSwitcher'

const project = (id: string, extra: Partial<Project> = {}): Project =>
  ({ id, name: id.toUpperCase(), color: 'blue', path: `/repo/${id}`, ...extra }) as Project

const openProject = vi.fn()
const onNewProject = vi.fn()

function renderSwitcher(pressed = false) {
  const projects = [project('a'), project('b'), project('c', { isArchived: true })]
  render(
    <TooltipProvider>
      <ProjectSwitcher
        projects={projects}
        activeProject={projects[0]}
        openProject={openProject}
        onNewProject={onNewProject}
        trigger={<span>+2</span>}
        label="2 more projects"
        pressed={pressed}
      />
    </TooltipProvider>
  )
  return screen.getByRole('button', { name: '2 more projects' })
}

beforeEach(() => {
  vi.clearAllMocks()
  // cmdk scrolls the selected item into view; jsdom has no layout.
  Element.prototype.scrollIntoView = vi.fn()
})

describe('ProjectSwitcher', () => {
  it('renders the given trigger under the given name', () => {
    expect(renderSwitcher()).toHaveTextContent('+2')
  })

  it('takes the keycap surface only when pressed', () => {
    expect(renderSwitcher(true)).toHaveClass('keycap')
  })

  it('lists open projects and opens the picked one', () => {
    fireEvent.click(renderSwitcher())
    expect(screen.queryByText('/repo/c')).toBeNull()
    fireEvent.click(screen.getByText('/repo/b'))
    expect(openProject).toHaveBeenCalledWith('b')
  })

  it('offers a new project', () => {
    fireEvent.click(renderSwitcher())
    fireEvent.click(screen.getByText('New project'))
    expect(onNewProject).toHaveBeenCalledTimes(1)
  })
})
