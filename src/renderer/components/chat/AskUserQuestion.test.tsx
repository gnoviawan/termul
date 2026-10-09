import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => true
}))

const { mockAnswer } = vi.hoisted(() => ({ mockAnswer: vi.fn() }))

vi.mock('@/stores/acp-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/acp-store')>()
  return {
    ...actual,
    useAcpStore: (sel: (s: unknown) => unknown) => sel({ answerQuestion: mockAnswer })
  }
})

import { AskUserQuestion } from './AskUserQuestion'

const question = {
  questionId: 'q-1',
  agentId: 'agent-1',
  sessionId: 's1',
  question: 'Which approach?',
  options: [
    { value: 'plan-a', label: 'Plan A', description: 'Fast, iterative' },
    { value: 'plan-b', label: 'Plan B' }
  ]
}

describe('AskUserQuestion (issue #411)', () => {
  beforeEach(() => {
    mockAnswer.mockReset().mockResolvedValue(undefined)
  })

  it('renders the question text and numbered option labels', () => {
    render(<AskUserQuestion question={question} />)
    // The heading carries the question (the sr-only fieldset legend repeats
    // it for AT, so query the heading role specifically).
    expect(screen.getByRole('heading', { name: 'Which approach?' })).toBeInTheDocument()
    expect(screen.getByText('Plan A')).toBeInTheDocument()
    expect(screen.getByText('Plan B')).toBeInTheDocument()
    expect(screen.getByText(/Fast, iterative/)).toBeInTheDocument()
    // Stepper chrome: Question label + 1 of 1 counter.
    expect(screen.getByText('Question')).toBeInTheDocument()
    expect(screen.getByText('1 of 1')).toBeInTheDocument()
  })

  it('bounds the option list in a scrollable region so the panel cannot cover the pane', () => {
    render(<AskUserQuestion question={question} />)
    const scroller = screen
      .getByRole('button', { name: /Plan A/ })
      .closest('[class*="overflow-y-auto"]')
    expect(scroller).not.toBeNull()
    expect(scroller?.className).toContain('max-h-')
    expect(scroller?.className).toContain('scroller-thin')
    // The pinned footer sits outside the scroller so actions stay visible.
    expect(scroller).not.toContainElement(screen.getByRole('button', { name: 'Submit' }))
  })

  it('renders the composer-surface chrome: neutral card on the composer slot', () => {
    render(<AskUserQuestion question={question} />)
    const card = screen.getByTestId('ask-user-question').firstElementChild
    expect(card).toHaveClass('border-border/60', 'bg-card', 'rounded-2xl')
  })

  it('hides the option scroller and Submit when the agent provides no options', () => {
    render(<AskUserQuestion question={{ ...question, options: [] }} />)
    expect(screen.getByText('The agent provided no options.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('single-select: choosing an option and submitting sends one value', () => {
    render(<AskUserQuestion question={question} />)
    fireEvent.click(screen.getByText('Plan A'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(mockAnswer).toHaveBeenCalledWith('q-1', ['plan-a'])
  })

  it('multi-select: multiple selections are submitted together', () => {
    const multi = {
      ...question,
      options: [
        { value: 'a', label: 'A', cardinality: 'multi' },
        { value: 'b', label: 'B', cardinality: 'multi' }
      ]
    }
    render(<AskUserQuestion question={multi} />)
    fireEvent.click(screen.getByText('A'))
    fireEvent.click(screen.getByText('B'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(mockAnswer).toHaveBeenCalledWith('q-1', ['a', 'b'])
  })

  it('keeps Submit disabled until an option is selected', () => {
    const multi = {
      ...question,
      options: [
        { value: 'a', label: 'A', cardinality: 'multi' },
        { value: 'b', label: 'B', cardinality: 'multi' }
      ]
    }
    render(<AskUserQuestion question={multi} />)
    const send = screen.getByRole('button', { name: 'Submit' })
    expect(send).toBeDisabled()
    // Enter must not bypass the disabled state.
    fireEvent.keyDown(screen.getByRole('heading'), { key: 'Enter' })
    expect(mockAnswer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('A'))
    expect(send).toBeEnabled()
  })

  it('renders borderless option rows on the composer surface', () => {
    render(<AskUserQuestion question={question} />)
    const option = screen.getByRole('button', { name: /Plan A/ })
    expect(option.className).not.toMatch(/(^|\s)border(\s|$|-)/)
  })

  it('digit keys select options and Enter submits', () => {
    render(<AskUserQuestion question={question} />)
    // Keys bubble from any focused element up to the stepper's onKeyDown.
    const optionA = screen.getByRole('button', { name: /Plan A/ })
    fireEvent.keyDown(optionA, { key: '2' })
    expect(screen.getByRole('button', { name: /Plan B/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.keyDown(screen.getByRole('heading'), { key: 'Enter' })
    expect(mockAnswer).toHaveBeenCalledWith('q-1', ['plan-b'])
  })

  it('Enter on a button keeps native activation instead of submitting', () => {
    render(<AskUserQuestion question={question} />)
    fireEvent.click(screen.getByText('Plan A'))
    // Enter on × or an option must not be hijacked into Submit.
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const enter = fireEvent.keyDown(cancel, { key: 'Enter' })
    expect(enter).toBe(true) // not preventDefault-ed → native click fires
    fireEvent.keyDown(screen.getByRole('button', { name: /Plan B/ }), { key: 'Enter' })
    expect(mockAnswer).not.toHaveBeenCalled()
  })

  it('cancel via the × button resolves the question as cancelled', () => {
    render(<AskUserQuestion question={question} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mockAnswer).toHaveBeenCalledWith('q-1', undefined)
  })
})
