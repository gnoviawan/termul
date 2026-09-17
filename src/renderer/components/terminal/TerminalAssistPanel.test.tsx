import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { extractSuggestedCommands, TerminalAssistPanel } from './TerminalAssistPanel'

describe('extractSuggestedCommands', () => {
  it('collects fenced sh/bash/bare blocks and skips empty ones', () => {
    const markdown = [
      'The port is in use.',
      '',
      '```sh',
      'lsof -i :3000',
      '```',
      '',
      '```',
      'kill -9 $(lsof -t -i :3000)',
      '```',
      '',
      '```sh',
      '   ',
      '```'
    ].join('\n')
    expect(extractSuggestedCommands(markdown)).toEqual([
      'lsof -i :3000',
      'kill -9 $(lsof -t -i :3000)'
    ])
  })

  it('never offers multi-line or control-character commands for insertion', () => {
    // #689 review (CWE-78): terminalApi.write feeds the PTY directly, so a
    // newline or control byte inside a suggested block would execute it —
    // the extractor must refuse such blocks outright.
    const markdown = [
      'Do this:',
      '',
      '```sh',
      'echo one',
      'echo two',
      '```',
      '',
      '```sh',
      'ping \x1b[C example.com',
      '```',
      '',
      '```sh',
      'safe --single-line',
      '```'
    ].join('\n')
    expect(extractSuggestedCommands(markdown)).toEqual(['safe --single-line'])
  })

  it('returns nothing when there are no code blocks', () => {
    expect(extractSuggestedCommands('just prose, no fences')).toEqual([])
  })
})

describe('TerminalAssistPanel', () => {
  it('renders the loading state without insert actions', () => {
    render(
      <TerminalAssistPanel
        state={{ kind: 'explain', status: 'loading' }}
        onClose={vi.fn()}
        onInsertCommand={vi.fn()}
      />
    )
    expect(screen.getByRole('status').textContent).toContain('Asking the configured agent')
    expect(
      screen.queryByRole('button', { name: /insert suggested command/i })
    ).not.toBeInTheDocument()
  })

  it('renders the error message', () => {
    render(
      <TerminalAssistPanel
        state={{ kind: 'fix', status: 'error', error: 'Configure and select an ACP agent' }}
        onClose={vi.fn()}
        onInsertCommand={vi.fn()}
      />
    )
    expect(screen.getByRole('alert').textContent).toContain('Configure and select an ACP agent')
  })

  it('renders sanitized markdown and offers each suggested command for insertion', () => {
    const onInsertCommand = vi.fn()
    const { rerender } = render(
      <TerminalAssistPanel
        state={{
          kind: 'fix',
          status: 'done',
          text: 'Port in use.\n\n```sh\nlsof -i :3000\n```\n\n```sh\nkill $(lsof -t -i :3000)\n```'
        }}
        onClose={vi.fn()}
        onInsertCommand={onInsertCommand}
      />
    )
    expect(screen.getByText('Port in use.')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: /insert suggested command/i })
    expect(buttons).toHaveLength(2)

    fireEvent.click(buttons[0])
    expect(onInsertCommand).toHaveBeenCalledWith('lsof -i :3000')
    expect(onInsertCommand).toHaveBeenCalledTimes(1)

    // Closing hides via the parent (state reset), not internal logic.
    rerender(
      <TerminalAssistPanel
        state={{ kind: 'fix', status: 'loading' }}
        onClose={vi.fn()}
        onInsertCommand={onInsertCommand}
      />
    )
    expect(
      screen.queryByRole('button', { name: /insert suggested command/i })
    ).not.toBeInTheDocument()
  })
})

describe('TerminalAssistPanel keyboard', () => {
  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(
      <TerminalAssistPanel
        state={{ kind: 'explain', status: 'loading' }}
        onClose={onClose}
        onInsertCommand={vi.fn()}
      />
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
