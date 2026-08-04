import { render, screen } from '@testing-library/react'
import type { SVGProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { FileTreeNode } from './FileTreeNode'

vi.mock('@/hooks/use-pane-dnd', () => ({
  usePaneDnd: () => ({
    startFileDrag: vi.fn()
  })
}))

vi.mock('./file-icon-map', () => ({
  getFileIcon: () => (props: SVGProps<SVGSVGElement>) => <svg data-testid="file-icon" {...props} />
}))

describe('FileTreeNode', () => {
  it('keeps long names on the truncate path without forcing the row wider', () => {
    const longName =
      'xxxxxxxxxxxxxxxxxxxxxxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxx_xxxxxxxxxxxxxxxx_rev.docx'

    render(
      <FileTreeNode
        entry={{
          path: `/project/${longName}`,
          name: longName,
          type: 'file',
          extension: 'docx',
          size: 1024,
          modifiedAt: Date.UTC(2026, 5, 10)
        }}
        depth={0}
        isExpanded={false}
        isSelected={false}
        isLoading={false}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    const nameEl = screen.getByText(longName)
    expect(nameEl).toHaveClass('min-w-0', 'flex-1', 'truncate')
    expect(nameEl.parentElement).toHaveClass('min-w-0', 'overflow-hidden')
  })

  it('exposes the entry path via data-path for reveal/scroll lookups (GH-539)', () => {
    render(
      <FileTreeNode
        entry={{
          path: '/project/src/new-file.txt',
          name: 'new-file.txt',
          type: 'file',
          extension: 'txt',
          size: 10,
          modifiedAt: Date.UTC(2026, 5, 10)
        }}
        depth={1}
        isExpanded={false}
        isSelected={true}
        isLoading={false}
        onToggle={vi.fn()}
        onSelect={vi.fn()}
        onContextMenu={vi.fn()}
      />
    )

    const row = document.querySelector('[data-path="/project/src/new-file.txt"]')
    expect(row).not.toBeNull()
    expect(row).toHaveClass('bg-accent')
  })
})
