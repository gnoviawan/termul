import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/project-store'
import type { Project } from '@/types/project'
import { useShellLayoutHydration } from './use-shell-layout-hydration'

const { mockHydrate, mockRemoveProject } = vi.hoisted(() => ({
  mockHydrate: vi.fn(),
  mockRemoveProject: vi.fn()
}))

vi.mock('@/stores/shell-layout-store', () => ({
  useShellLayoutStore: {
    getState: () => ({ hydrate: mockHydrate, removeProject: mockRemoveProject })
  }
}))

function project(id: string): Project {
  return { id, name: id, color: 'blue' }
}

describe('useShellLayoutHydration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHydrate.mockResolvedValue(undefined)
    mockRemoveProject.mockResolvedValue(undefined)
    useProjectStore.setState({ projects: [], activeProjectId: '', isLoaded: false })
  })

  it('hydrates once on mount', () => {
    const { rerender } = renderHook(() => useShellLayoutHydration())
    rerender()
    expect(mockHydrate).toHaveBeenCalledTimes(1)
  })

  it('does not treat the initial project load as a removal', () => {
    useProjectStore.setState({ projects: [project('a')], isLoaded: false })
    renderHook(() => useShellLayoutHydration())
    act(() => {
      useProjectStore.getState().setProjects([project('b')], 'b')
    })
    expect(mockRemoveProject).not.toHaveBeenCalled()
  })

  it('does not remove anything when projects are only added', () => {
    useProjectStore.setState({ projects: [project('a')], activeProjectId: 'a', isLoaded: true })
    renderHook(() => useShellLayoutHydration())
    act(() => {
      useProjectStore.getState().setProjects([project('a'), project('b')], 'a')
    })
    expect(mockRemoveProject).not.toHaveBeenCalled()
  })

  it('removes every project that disappears between two loaded states', () => {
    useProjectStore.setState({
      projects: [project('a'), project('b'), project('c')],
      activeProjectId: 'a',
      isLoaded: true
    })
    renderHook(() => useShellLayoutHydration())
    act(() => {
      useProjectStore.getState().setProjects([project('b')], 'b')
    })
    expect(mockRemoveProject).toHaveBeenCalledTimes(2)
    expect(mockRemoveProject).toHaveBeenCalledWith('a')
    expect(mockRemoveProject).toHaveBeenCalledWith('c')
  })

  it('ignores unrelated store changes and stops after unmount', () => {
    useProjectStore.setState({ projects: [project('a')], activeProjectId: 'a', isLoaded: true })
    const { unmount } = renderHook(() => useShellLayoutHydration())
    act(() => {
      useProjectStore.setState({ activeProjectId: 'a' })
    })
    expect(mockRemoveProject).not.toHaveBeenCalled()
    unmount()
    act(() => {
      useProjectStore.getState().setProjects([], '')
    })
    expect(mockRemoveProject).not.toHaveBeenCalled()
  })
})
