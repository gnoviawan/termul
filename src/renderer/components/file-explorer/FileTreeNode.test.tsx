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
          extension: 'docx'
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
})
