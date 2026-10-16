import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileExplorerStore } from '@/stores/file-explorer-store'
import { FileExplorer } from './FileExplorer'

const renders = vi.hoisted(() => ({ rows: [] as string[], menus: 0 }))

vi.mock('./MaterialFileIcon', () => ({
  MaterialFileIcon: ({ name }: { name: string }) => {
    renders.rows.push(name)
    return null
  }
}))

vi.mock('@/components/ui/context-menu', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/components/ui/context-menu')>()
  const RealContent = original.ContextMenuContent
  return {
    ...original,
    ContextMenuContent: (props: React.ComponentProps<typeof RealContent>) => {
      renders.menus++
      return <RealContent {...props} />
    }
  }
})

vi.mock('@/stores/git-status-store', () => {
  const state = { statuses: {}, refreshStatus: vi.fn().mockResolvedValue(undefined) }
  return {
    useGitStatusStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state
    })
  }
})

function dir(path: string): DirectoryEntry {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    type: 'directory',
    extension: null,
    size: 0,
    modifiedAt: 0
  }
}

function file(path: string): DirectoryEntry {
  return { ...dir(path), type: 'file', extension: '.ts', size: 1 }
}

beforeEach(() => {
  useFileExplorerStore.setState({
    rootPath: '/proj',
    directoryContents: new Map([
      ['/proj', [dir('/proj/a'), dir('/proj/b')]],
      ['/proj/a', [file('/proj/a/one.ts'), file('/proj/a/two.ts'), file('/proj/a/three.ts')]],
      ['/proj/b', [file('/proj/b/four.ts')]]
    ]),
    expandedDirs: new Set(['/proj', '/proj/a', '/proj/b']),
    loadingDirs: new Set(),
    selectedPaths: new Set(),
    lastClickedPath: null,
    clipboard: null,
    rootLoadError: null,
    suppressTreeAnimations: true
  })
  render(<FileExplorer />)
})

function row(path: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-path="${path}"]`)
  if (!element) throw new Error(`no tree row for ${path}`)
  return element
}

describe('FileExplorer tree rendering', () => {
  it('re-renders only the rows whose selection state changed', () => {
    renders.rows = []
    renders.menus = 0
    act(() => useFileExplorerStore.getState().selectPath('/proj/a/two.ts'))
    expect(renders.rows.sort()).toEqual(['a', 'two.ts'])
    expect(renders.menus).toBe(2)

    renders.rows = []
    renders.menus = 0
    act(() => useFileExplorerStore.getState().copySelected())
    expect(useFileExplorerStore.getState().clipboard).toEqual({
      type: 'copy',
      paths: ['/proj/a/two.ts']
    })
    expect(renders.rows).toEqual([])
    expect(renders.menus).toBe(0)
  })
})

describe('FileExplorer tree context menu', () => {
  it('counts the multi-selection made after the tree rendered', () => {
    fireEvent.click(row('/proj/a/one.ts'), { ctrlKey: true })
    fireEvent.click(row('/proj/a/three.ts'), { ctrlKey: true })
    fireEvent.contextMenu(row('/proj/a/three.ts'))

    expect(screen.getByRole('menuitem', { name: 'Copy (2)' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete (2)…' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Rename (1 item)' })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  })

  it('offers Paste on a folder once a row was copied', () => {
    fireEvent.contextMenu(row('/proj/a/one.ts'))
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.contextMenu(row('/proj/b'))
    expect(screen.getByRole('menuitem', { name: 'Paste' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeInTheDocument()
  })
})
