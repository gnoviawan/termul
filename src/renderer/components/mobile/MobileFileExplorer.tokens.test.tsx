import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Story 12 (QA F7): MobileFileExplorer token/copy contract —
//   - sheet header normalized to the p-2 family (no px-3 py-3 drift)
//   - action sheet inherits rounded-t-xl from the Sheet component default
//   - delete confirm uses destructive tokens (no raw bg-red-500)

let mockReducedMotion = false

vi.mock('framer-motion', async () => {
  const React = await import('react')
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        ({ children, ...props }, ref) => (
          <div ref={ref} {...props}>
            {children}
          </div>
        )
      )
    },
    useReducedMotion: () => mockReducedMotion
  }
})

const mockToggleDirectory = vi.fn().mockResolvedValue(undefined)
const mockRefreshDirectory = vi.fn().mockResolvedValue(undefined)
const mockSelectPath = vi.fn()

const mockOpenFile = vi.fn()
const mockAddEditorTab = vi.fn()
const mockRemoveTab = vi.fn()

const mockEditorStore = { openFiles: new Map<string, { isDirty: boolean }>() }

const mockCreateFile = vi.fn()
const mockCreateDirectory = vi.fn()
const mockDeletePath = vi.fn()
const mockRenameFile = vi.fn()
const mockCopyFile = vi.fn()
const mockToastError = vi.fn()
const mockPersistenceRead = vi.fn()
const mockPersistenceWrite = vi.fn()
let mockProjectId: string | undefined

const mockExplorerState = {
  rootPath: '/proj' as string | null,
  directoryContents: new Map<string, DirectoryEntry[]>(),
  expandedDirs: new Set<string>(),
  loadingDirs: new Set<string>(),
  rootLoadError: null as { message: string; code: string } | null
}

vi.mock('@/stores/file-explorer-store', () => ({
  useFileExplorer: () => mockExplorerState,
  useFileExplorerActions: () => ({
    toggleDirectory: mockToggleDirectory,
    refreshDirectory: mockRefreshDirectory,
    selectPath: mockSelectPath,
    collapseAll: vi.fn()
  })
}))

vi.mock('@/stores/editor-store', () => ({
  useEditorStore: (selector: (s: unknown) => unknown) => selector(mockEditorStore)
}))

vi.mock('@/stores/workspace-store', () => ({
  useWorkspaceStore: Object.assign(
    vi.fn((sel: (s: unknown) => unknown) =>
      sel({ addEditorTab: mockAddEditorTab, removeTab: mockRemoveTab })
    ),
    { getState: () => ({ addEditorTab: mockAddEditorTab, removeTab: mockRemoveTab }) }
  )
}))

vi.mock('@/stores/project-store', () => ({
  useActiveProjectId: () => mockProjectId
}))

vi.mock('@/lib/api', () => ({
  filesystemApi: {
    createFile: (...args: unknown[]) => mockCreateFile(...(args as [])),
    createDirectory: (...args: unknown[]) => mockCreateDirectory(...(args as [])),
    deletePath: (...args: unknown[]) => mockDeletePath(...(args as [])),
    renameFile: (...args: unknown[]) => mockRenameFile(...(args as [])),
    copyFile: (...args: unknown[]) => mockCopyFile(...(args as []))
  },
  persistenceApi: {
    read: (...args: unknown[]) => mockPersistenceRead(...(args as [])),
    write: (...args: unknown[]) => mockPersistenceWrite(...(args as []))
  }
}))

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => mockToastError(...(args as [])) }
}))

vi.mock('@/components/file-explorer/MaterialFileIcon', () => ({
  MaterialFileIcon: () => <span data-testid="mfi" />
}))

import { MobileFileExplorer } from './MobileFileExplorer'

function explorerEntry(name: string, type: 'file' | 'directory'): DirectoryEntry {
  return {
    name,
    type,
    path: `/proj/${name}`,
    extension: name.includes('.') ? (name.split('.').pop() ?? '') : undefined
  } as DirectoryEntry
}

describe('MobileFileExplorer token sweep (story 12)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProjectId = undefined
    mockPersistenceRead.mockReset()
    mockPersistenceWrite.mockReset()
    mockReducedMotion = false
    mockExplorerState.rootPath = '/proj'
    mockExplorerState.directoryContents = new Map([
      ['/proj', [explorerEntry('doomed.txt', 'file')]]
    ])
    mockExplorerState.expandedDirs = new Set()
    // Keep the open effect from firing a load while asserting structure.
    mockExplorerState.loadingDirs = new Set(['/proj'])
    mockExplorerState.rootLoadError = null
    mockOpenFile.mockResolvedValue(true)
    mockDeletePath.mockResolvedValue({ success: true, data: undefined })
    mockEditorStore.openFiles.clear()
  })

  it('explorer sheet header uses the p-2 family (no px-3 py-3 drift)', () => {
    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    // Radix portals the SheetContent to document.body — query globally.
    const sheets = document.querySelectorAll('[data-sheet]')
    expect(sheets.length).toBeGreaterThanOrEqual(1)
    const explorerSheet = sheets[0]
    const headerDiv = explorerSheet.querySelector('.border-b')
    expect(headerDiv).toBeTruthy()
    const cls = headerDiv?.className ?? ''
    expect(cls).toContain('p-2')
    expect(cls).not.toContain('px-3')
    expect(cls).not.toContain('px-4')
  })

  it('action sheet inherits rounded-t-xl from the Sheet component default', async () => {
    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    fireEvent.click(await screen.findByLabelText('Actions for doomed.txt'))

    // The action sheet is the second [data-sheet] (portal mounts after the
    // explorer sheet). Bottom sheets inherit the radius from sheet.tsx's
    // side=bottom variant — the call site no longer hand-rolls the class.
    const sheets = document.querySelectorAll('[data-sheet]')
    expect(sheets.length).toBeGreaterThanOrEqual(2)
    const actionSheet = sheets[sheets.length - 1]
    expect(actionSheet.className).toContain('rounded-t-xl')
  })

  it('delete confirm uses destructive tokens, not raw bg-red-500', async () => {
    render(<MobileFileExplorer open onOpenChange={vi.fn()} />)

    fireEvent.click(await screen.findByLabelText('Actions for doomed.txt'))
    fireEvent.click(await screen.findByText('Delete'))

    const dialog = await screen.findByRole('alertdialog')
    const confirmBtn = within(dialog).getByRole('button', { name: 'Delete' })
    expect(confirmBtn.className).toContain('bg-destructive')
    expect(confirmBtn.className).toContain('text-destructive-foreground')
    // Raw palette classes must be gone from the swept mobile path.
    expect(confirmBtn.className).not.toContain('bg-red-500')
    expect(confirmBtn.className).not.toContain('text-white')
  })
})
