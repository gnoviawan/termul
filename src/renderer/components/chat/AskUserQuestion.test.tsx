import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAcpStore } from '@/stores/acp-store'

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

  it('renders the question text and option labels', () => {
    render(<AskUserQuestion question={question} />)
    expect(screen.getByText('Which approach?')).toBeInTheDocument()
    expect(screen.getByText('Plan A')).toBeInTheDocument()
    expect(screen.getByText('Plan B')).toBeInTheDocument()
    expect(screen.getByText('Fast, iterative')).toBeInTheDocument()
  })

  it('single-select: choosing an option and submitting sends one value', () => {
    render(<AskUserQuestion question={question} />)
    fireEvent.click(screen.getByText('Plan A'))
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(mockAnswer).toHaveBeenCalledWith('q-1', ['a', 'b'])
  })

  it('shows an error and does not send when nothing is selected', () => {
    const multi = {
      ...question,
      options: [
        { value: 'a', label: 'A', cardinality: 'multi' },
        { value: 'b', label: 'B', cardinality: 'multi' }
      ]
    }
    render(<AskUserQuestion question={multi} />)
    const send = screen.getByRole('button', { name: 'Send answer' })
    expect(send).toBeEnabled()
    fireEvent.click(send)
    expect(mockAnswer).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Select an option.')
  })

  it('cancel resolves the question as cancelled', () => {
    render(<AskUserQuestion question={question} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mockAnswer).toHaveBeenCalledWith('q-1', undefined)
  })
})

void useAcpStore

describe('AskUserQuestion arrival focus (mobile dock)', () => {
  beforeEach(() => {
    mockAnswer.mockReset().mockResolvedValue(undefined)
  })

  it('tags the root as an approval prompt with its question id', () => {
    render(<AskUserQuestion question={question} />)
    expect(screen.getByTestId('ask-user-question')).toHaveAttribute(
      'data-approval-prompt',
      'question:q-1'
    )
  })

  it('does not move focus unless asked to', () => {
    render(<AskUserQuestion question={question} />)
    expect(document.body).toHaveFocus()
  })

  it('focuses the first option on mount when autoFocusFirstOption is set', () => {
    render(<AskUserQuestion question={question} autoFocusFirstOption />)
    expect(screen.getByRole('button', { name: /Plan A/ })).toHaveFocus()
  })

  it('focuses "Cancel" when the question has no options', () => {
    render(<AskUserQuestion question={{ ...question, options: [] }} autoFocusFirstOption />)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('focuses the first option when the pane becomes visible with the question open', () => {
    const { rerender } = render(
      <AskUserQuestion question={question} autoFocusFirstOption={false} />
    )
    expect(document.body).toHaveFocus()

    rerender(<AskUserQuestion question={question} autoFocusFirstOption />)
    expect(screen.getByRole('button', { name: /Plan A/ })).toHaveFocus()
  })

  it('does not steal focus again on an unrelated re-render while the prop stays true', () => {
    const { rerender } = render(<AskUserQuestion question={question} autoFocusFirstOption />)
    const planB = screen.getByRole('button', { name: /Plan B/ })
    planB.focus()

    rerender(<AskUserQuestion question={{ ...question }} autoFocusFirstOption />)
    expect(planB).toHaveFocus()
  })
})
