import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileTreeContextMenuContent } from '@/components/file-explorer/FileTreeContextMenu'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useFileExplorerStore } from '@/stores/file-explorer-store'

const mockIsTauriContext = vi.hoisted(() => vi.fn())

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

const fileEntry: DirectoryEntry = {
  name: 'file.txt',
  path: '/proj/file.txt',
  type: 'file',
  extension: '.txt',
  size: 100,
  modifiedAt: 0
}

const dirEntry: DirectoryEntry = {
  name: 'src',
  path: '/proj/src',
  type: 'directory',
  extension: null,
  size: 0,
  modifiedAt: 0
}

function renderMenu(entry: DirectoryEntry, hasClipboardContent = false): void {
  useFileExplorerStore.setState({
    selectedPaths: new Set([entry.path]),
    clipboard: hasClipboardContent ? { type: 'copy', paths: ['/proj/other.txt'] } : null
  })
  render(
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>{entry.name}</div>
      </ContextMenuTrigger>
      <FileTreeContextMenuContent
        entry={entry}
        onNewFile={vi.fn()}
        onNewFolder={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCopyPath={vi.fn()}
        onCopy={vi.fn()}
        onCut={vi.fn()}
        onPaste={vi.fn()}
        onDuplicate={vi.fn()}
        onOpenInTerminal={vi.fn()}
        onOpenWithExternal={vi.fn()}
        onShowInFileManager={vi.fn()}
      />
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByText(entry.name))
}

describe('FileTreeContextMenu capability gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('hides Reveal in File Manager and Open with External App on web (file)', () => {
    mockIsTauriContext.mockReturnValue(false)
    renderMenu(fileEntry)

    expect(screen.queryByText('Show in File Manager')).not.toBeInTheDocument()
    expect(screen.queryByText('Open with External App')).not.toBeInTheDocument()
  })

  it('shows Reveal in File Manager and Open with External App on desktop (file)', () => {
    mockIsTauriContext.mockReturnValue(true)
    renderMenu(fileEntry)

    expect(screen.getByText('Show in File Manager')).toBeInTheDocument()
    expect(screen.getByText('Open with External App')).toBeInTheDocument()
  })

  it('hides Show in File Manager on web but keeps Open in Terminal (directory)', () => {
    mockIsTauriContext.mockReturnValue(false)
    renderMenu(dirEntry)

    expect(screen.queryByText('Show in File Manager')).not.toBeInTheDocument()
    // Open in Terminal works on web (server-side PTY).
    expect(screen.getByText('Open in Terminal')).toBeInTheDocument()
  })
})

describe('FileTreeContextMenu grouping', () => {
  it('orders folder items as create | clipboard | rename | external | delete', () => {
    mockIsTauriContext.mockReturnValue(true)
    renderMenu(dirEntry, true)
    const sequence = Array.from(
      screen.getByRole('menu').querySelectorAll('[role="menuitem"], [role="separator"]')
    ).map((node) =>
      node.getAttribute('role') === 'separator' ? '|' : (node.textContent ?? '').trim()
    )
    expect(sequence).toEqual([
      'New File',
      'New Folder',
      '|',
      'Copy',
      'Cut',
      'Paste',
      'Duplicate',
      '|',
      'Rename',
      'Copy Path',
      '|',
      'Open in Terminal',
      'Show in File Manager',
      '|',
      'Delete…'
    ])
  })
})
