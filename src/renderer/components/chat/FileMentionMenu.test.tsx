import { fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { FileMentionMenu, type FileMentionMenuHandle } from './FileMentionMenu'
import {
  buildMentionSections,
  type MentionMatch,
  type MentionMenuInput,
  type MentionMenuView
} from './mention-menu-model'

const ROOT = '/root'

const match = (relPath: string, ignored = false): MentionMatch => ({
  relPath,
  absPath: `${ROOT}/${relPath}`,
  name: relPath.split('/').pop() ?? relPath,
  ignored
})

const dirMatch = (relPath: string): MentionMatch => ({
  ...match(relPath),
  absPath: `${ROOT}/${relPath}/`,
  kind: 'dir'
})

function view(input: Partial<MentionMenuInput>, extra: Partial<MentionMenuView> = {}) {
  return {
    panelKey: '1:root',
    header: null,
    enter: 'none' as const,
    emptyLabel: 'No files or folders match. Try another name.',
    sections: buildMentionSections({
      panel: { kind: 'root' },
      root: ROOT,
      filter: 'a',
      matches: [],
      recents: [],
      conversations: [],
      ...input
    }),
    ...extra
  }
}

describe('FileMentionMenu', () => {
  it('dims ignored rows and fires onSelect with the picked row', () => {
    const onSelect = vi.fn()
    render(
      <FileMentionMenu
        menu={view({ matches: [match('src/auth.ts'), match('node_modules/pkg/index.js', true)] })}
        onSelect={onSelect}
        onBack={vi.fn()}
      />
    )
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[1].className).toContain('text-disabled-foreground')
    expect(options[0].className).not.toContain('text-disabled-foreground')

    fireEvent.click(options[0])
    expect(onSelect).toHaveBeenCalledWith({ kind: 'file', match: match('src/auth.ts') })
  })

  it('renders the Explorer category with a chevron and drills on ArrowRight', () => {
    const onSelect = vi.fn()
    const ref = createRef<FileMentionMenuHandle>()
    render(
      <FileMentionMenu ref={ref} menu={view({ filter: '' })} onSelect={onSelect} onBack={vi.fn()} />
    )
    const [, option] = screen.getAllByRole('option')
    expect(option).toHaveTextContent('ExplorerFiles and folders in root/')
    fireEvent.mouseEnter(option)
    expect(option.querySelector('[data-termul-icon="ChevronRight"]')).not.toBeNull()
    expect(ref.current?.drillHighlighted()).toBe(true)
    expect(onSelect).toHaveBeenCalledWith({ kind: 'category', target: 'explorer' })
  })

  it('does not drill a file row on ArrowRight', () => {
    const onSelect = vi.fn()
    const ref = createRef<FileMentionMenuHandle>()
    render(
      <FileMentionMenu
        ref={ref}
        menu={view({ matches: [match('a.ts'), dirMatch('src')] })}
        onSelect={onSelect}
        onBack={vi.fn()}
      />
    )
    expect(ref.current?.drillHighlighted()).toBe(false)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows a back header with the folder crumb and goes back on click', () => {
    const onBack = vi.fn()
    render(
      <FileMentionMenu
        menu={view(
          {
            panel: { kind: 'explorer', dir: `${ROOT}/src` },
            filter: '',
            listing: { status: 'error' }
          },
          { header: { title: 'Explorer', crumb: 'src/' }, enter: 'forward' }
        )}
        onSelect={vi.fn()}
        onBack={onBack}
      />
    )
    const back = screen.getByRole('button', { name: 'Back from Explorer' })
    expect(back).toHaveTextContent('Explorersrc/')
    expect(screen.getByText("Couldn't list this folder")).toBeInTheDocument()
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('shows the agent, a running spinner, and the chat icon on conversation rows', () => {
    const onSelect = vi.fn()
    const conversation = {
      sessionId: 's1',
      title: 'Fix web reconnect',
      agentName: 'Claude',
      lastActivityAt: Date.now(),
      running: true
    }
    render(
      <FileMentionMenu
        menu={view({ panel: { kind: 'conversations' }, filter: '', conversations: [conversation] })}
        onSelect={onSelect}
        onBack={vi.fn()}
      />
    )
    const [option] = screen.getAllByRole('option')
    expect(option).toHaveTextContent('Fix web reconnect')
    expect(option).toHaveTextContent('Claude · now')
    expect(option.querySelector('[data-termul-icon="MessageSquare"]')).not.toBeNull()
    expect(screen.getByLabelText('Running')).toBeInTheDocument()
    fireEvent.click(option)
    expect(onSelect).toHaveBeenCalledWith({ kind: 'conversation', conversation })
  })

  it('renders the empty label when there are no sections', () => {
    render(<FileMentionMenu menu={view({ filter: 'zzz' })} onSelect={vi.fn()} onBack={vi.fn()} />)
    expect(screen.getByText('No files or folders match. Try another name.')).toBeInTheDocument()
  })
})
