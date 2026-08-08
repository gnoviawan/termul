import type { DirectoryEntry } from '@shared/types/filesystem.types'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { FileTreeContextMenu } from '@/components/file-explorer/FileTreeContextMenu'

const mockIsTauriContext = vi.hoisted(() => vi.fn())

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

// Stub ContextMenu so the test asserts the item labels that
// FileTreeContextMenu builds — the real ContextMenu renders via a portal +
// Radix positioning that is hard to assert in jsdom. Capturing the `items`
// prop keeps the test focused on the gating logic.
vi.mock('@/components/ContextMenu', () => ({
  ContextMenu: ({ items }: { items: ContextMenuItem[] }) => (
    <div data-testid="context-menu">
      {items.map((item, i) => (
        <span key={i}>{item.type === 'separator' ? '---' : item.label}</span>
      ))}
    </div>
  )
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

function renderMenu(entry: DirectoryEntry): void {
  render(
    <FileTreeContextMenu
      entry={entry}
      x={0}
      y={0}
      onClose={vi.fn()}
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
  )
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
