import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingElicitation } from '@/stores/acp-store'

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => true
}))

const { mockRespond } = vi.hoisted(() => ({ mockRespond: vi.fn() }))

vi.mock('@/stores/acp-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/acp-store')>()
  return {
    ...actual,
    useAcpStore: (sel: (s: unknown) => unknown) => sel({ respondElicitation: mockRespond })
  }
})

import { ElicitationPrompt } from './ElicitationPrompt'
import { ElicitationQuestions } from './ElicitationQuestions'

/** Devin-style `elicitation/create` form captured for GH-935. */
const pending: PendingElicitation = {
  requestId: 'el-1',
  agentId: 'agent-1',
  sessionId: 's1',
  mode: 'form',
  message: 'Which color should I use?',
  allowOther: true,
  fields: [
    {
      name: 'q0',
      kind: 'enum',
      required: true,
      title: 'Color',
      description: 'Which color should I use?',
      options: [
        { value: 'Red', label: 'Red', description: 'Use the red color' },
        { value: 'Blue', label: 'Blue', description: 'Use the blue color' }
      ]
    },
    {
      name: 'q1',
      kind: 'multi-enum',
      required: true,
      title: 'Features',
      description: 'Which features should I enable?',
      options: [
        { value: 'Logging', label: 'Logging', description: 'Enable logging' },
        { value: 'Tracing', label: 'Tracing', description: 'Enable tracing' }
      ]
    }
  ]
}

const renderPanel = (overrides: Partial<PendingElicitation> = {}) => {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  render(
    <ElicitationQuestions
      pending={{ ...pending, ...overrides }}
      submitting={false}
      headingId="test-question-heading"
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  )
  return { onSubmit, onCancel }
}

/** Click through to the last step so Submit is reachable. */
const goToLastStep = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Next' }))
}

describe('ElicitationQuestions (GH-935)', () => {
  beforeEach(() => {
    mockRespond.mockReset().mockResolvedValue(undefined)
  })

  it('renders one question at a time with the stepper chrome and no raw qN names', () => {
    renderPanel()
    expect(screen.getByTestId('elicitation-question-q0')).toBeInTheDocument()
    // Stepper chrome: Question label + pager counter; q1 not mounted yet.
    expect(screen.getByText('Question')).toBeInTheDocument()
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
    expect(screen.queryByTestId('elicitation-question-q1')).not.toBeInTheDocument()
    // The question text (description) is the heading; the short title names
    // the option group (sr-only legend) instead of a visible eyebrow.
    expect(screen.getByRole('heading', { name: 'Which color should I use?' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Color' })).toBeInTheDocument()
    expect(screen.getByText(/Use the red color/)).toBeInTheDocument()
    expect(screen.queryByText('q0')).not.toBeInTheDocument()
    expect(screen.queryByText('q1')).not.toBeInTheDocument()
  })

  it('paged navigation moves between questions and keeps answers', () => {
    renderPanel()
    const prev = screen.getByRole('button', { name: 'Previous question' })
    const next = screen.getByRole('button', { name: 'Next question' })
    expect(prev).toBeDisabled()
    fireEvent.click(next)
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
    expect(screen.getByTestId('elicitation-question-q1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Logging/ }))
    fireEvent.click(prev)
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
    // Pick Red — single-select auto-advances back to q1, which kept its toggle.
    fireEvent.click(screen.getByRole('button', { name: /Red/ }))
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Logging/ })).toHaveAttribute('aria-pressed', 'true')
  })

  it('bounds the option list in a scrollable region with the footer pinned outside', () => {
    renderPanel()
    const scroller = screen
      .getByRole('button', { name: /Red/ })
      .closest('[class*="overflow-y-auto"]')
    expect(scroller).not.toBeNull()
    expect(scroller?.className).toContain('max-h-')
    expect(scroller?.className).toContain('scroller-thin')
    expect(scroller).not.toContainElement(screen.getByRole('button', { name: 'Next' }))
  })

  it('Next stays disabled until the current question is answered', () => {
    renderPanel()
    const next = screen.getByRole('button', { name: 'Next' })
    expect(next).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Other answer for Color'), {
      target: { value: 'Chartreuse' }
    })
    expect(next).toBeEnabled()
    fireEvent.click(next)
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
  })

  it('option rows are borderless', () => {
    renderPanel()
    const option = screen.getByRole('button', { name: /Red/ })
    expect(option.className).not.toMatch(/(^|\s)border(\s|$|-)/)
  })

  it('submits answers gathered across steps; unanswered questions are omitted', () => {
    const { onSubmit } = renderPanel()
    // Picking a single-select option auto-advances to the next question.
    fireEvent.click(screen.getByRole('button', { name: /Red/ }))
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Logging/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledWith({ q0: 'Red', q1: ['Logging'] })
  })

  it('Skip leaves the current question unanswered and advances; Submit sends the rest', () => {
    const { onSubmit } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Logging/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledWith({ q1: ['Logging'] })
  })

  it('skipping every question submits an empty answer map', () => {
    const { onSubmit } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(onSubmit).toHaveBeenCalledWith({})
  })

  it('Skip on the last question submits the remaining answers', () => {
    const { onSubmit } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Red/ }))
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(onSubmit).toHaveBeenCalledWith({ q0: 'Red' })
  })

  it('Skip clears an answer already entered for the current question', () => {
    const { onSubmit } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Red/ }))
    // Back on q1 now; go back to q0, re-pick, then skip it.
    fireEvent.click(screen.getByRole('button', { name: 'Previous question' }))
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    fireEvent.click(screen.getByRole('button', { name: /Tracing/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledWith({ q1: ['Tracing'] })
  })

  it('multi-enum checkboxes toggle and submit sends string[] content', () => {
    const { onSubmit } = renderPanel({ fields: [pending.fields[1]] })
    fireEvent.click(screen.getByRole('button', { name: /Logging/ }))
    fireEvent.click(screen.getByRole('button', { name: /Tracing/ }))
    // Untoggling removes the value from the selection.
    fireEvent.click(screen.getByRole('button', { name: /Logging/ }))
    expect(screen.getByRole('button', { name: /Logging/ })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByRole('button', { name: /Logging/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledWith({ q1: ['Tracing', 'Logging'] })
  })

  it('Other text submits as a custom string value for enum questions', () => {
    const { onSubmit } = renderPanel({ fields: [pending.fields[0]] })
    fireEvent.change(screen.getByLabelText('Other answer for Color'), {
      target: { value: 'Chartreuse' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledWith({ q0: 'Chartreuse' })
  })

  it('Other text is appended to the multi-enum selection', () => {
    const { onSubmit } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Blue/ }))
    fireEvent.click(screen.getByRole('button', { name: /Logging/ }))
    fireEvent.change(screen.getByLabelText('Other answer for Features'), {
      target: { value: 'My custom feature' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledWith({
      q0: 'Blue',
      q1: ['Logging', 'My custom feature']
    })
  })

  it('Other and enum options are exclusive: typing deselects the option', () => {
    renderPanel({ fields: [pending.fields[0]] })
    const red = screen.getByRole('button', { name: /Red/ })
    fireEvent.click(red)
    expect(red).toHaveAttribute('aria-pressed', 'true')
    const input = screen.getByLabelText('Other answer for Color')
    fireEvent.change(input, { target: { value: 'Chartreuse' } })
    // Typing Other deselects the picked option.
    expect(red).toHaveAttribute('aria-pressed', 'false')
    // Picking an option again clears the Other text.
    fireEvent.click(red)
    expect(red).toHaveAttribute('aria-pressed', 'true')
    expect(input).toHaveValue('')
  })

  it('omits untouched optional questions from the submitted answers', () => {
    const optionalQ1 = { ...pending.fields[1], required: false }
    const { onSubmit } = renderPanel({ fields: [pending.fields[0], optionalQ1] })
    fireEvent.click(screen.getByRole('button', { name: /Red/ }))
    // Untouched q1: Submit is disabled, Skip on the last step submits.
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    const answers = onSubmit.mock.calls[0][0] as Record<string, string | string[]>
    expect(answers).toEqual({ q0: 'Red' })
    expect(answers).not.toHaveProperty('q1')
  })

  it('hides the Other affordance when the request does not allow custom answers', () => {
    renderPanel({ allowOther: false })
    expect(screen.queryByTestId('elicitation-other-q0')).not.toBeInTheDocument()
    goToLastStep()
    expect(screen.queryByTestId('elicitation-other-q1')).not.toBeInTheDocument()
  })

  it('clicking a picked single-select option deselects it (back to skipped)', () => {
    const { onSubmit } = renderPanel({ fields: [{ ...pending.fields[0], required: false }] })
    const red = screen.getByRole('button', { name: /Red/ })
    fireEvent.click(red)
    expect(red).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(red)
    expect(red).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    expect(onSubmit).toHaveBeenCalledWith({})
  })

  it('Other text matching a checked multi-enum option is not duplicated', () => {
    const { onSubmit } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Blue/ }))
    fireEvent.click(screen.getByRole('button', { name: /Logging/ }))
    fireEvent.change(screen.getByLabelText('Other answer for Features'), {
      target: { value: 'Logging' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledWith({ q0: 'Blue', q1: ['Logging'] })
  })

  it('whitespace-only Other text does not deselect the picked enum option', () => {
    const { onSubmit } = renderPanel({ fields: [pending.fields[0]] })
    const red = screen.getByRole('button', { name: /Red/ })
    fireEvent.click(red)
    fireEvent.change(screen.getByLabelText('Other answer for Color'), {
      target: { value: '   ' }
    })
    expect(red).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledWith({ q0: 'Red' })
  })

  it('Submit, Skip and navigation are disabled while a submission is in flight', () => {
    render(
      <ElicitationQuestions
        pending={pending}
        submitting={true}
        headingId="test-question-heading"
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Skip' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next question' })).toBeDisabled()
  })

  it('Cancel via the × button fires onCancel', () => {
    const { onCancel, onSubmit } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('ElicitationPrompt question mode (GH-935)', () => {
  beforeEach(() => {
    mockRespond.mockReset().mockResolvedValue(undefined)
  })

  it('renders the stepper panel and submits answers via respondElicitation', () => {
    render(<ElicitationPrompt request={pending} />)
    expect(screen.getByTestId('elicitation-questions')).toBeInTheDocument()
    // Stepper chrome on the composer-surface card.
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
    const card = screen.getByTestId('elicitation-prompt').firstElementChild
    expect(card).toHaveClass('border-border/60', 'bg-card', 'rounded-2xl')
    fireEvent.click(screen.getByRole('button', { name: /Red/ }))
    fireEvent.click(screen.getByRole('button', { name: /Logging/ }))
    fireEvent.click(screen.getByRole('button', { name: /Tracing/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(mockRespond).toHaveBeenCalledWith('el-1', 'accept', {
      q0: 'Red',
      q1: ['Logging', 'Tracing']
    })
  })

  it('Cancel resolves the elicitation as cancelled', () => {
    render(<ElicitationPrompt request={pending} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(mockRespond).toHaveBeenCalledWith('el-1', 'cancel', undefined)
  })

  it('shows the request message in question mode when it repeats no field description', () => {
    render(<ElicitationPrompt request={{ ...pending, message: 'A quick batch of questions' }} />)
    expect(screen.getByText('A quick batch of questions')).toBeInTheDocument()
  })

  it('shows the request message on the generic path', () => {
    const generic: PendingElicitation = {
      ...pending,
      message: 'Fill in your name',
      fields: [{ name: 'name', kind: 'string', required: true, options: [] }]
    }
    render(<ElicitationPrompt request={generic} />)
    expect(screen.getByText('Fill in your name')).toBeInTheDocument()
  })

  it('generic multi-enum checkboxes submit string[] content and honor required', () => {
    const generic: PendingElicitation = {
      ...pending,
      message: 'Pick features',
      fields: [
        {
          name: 'q1',
          kind: 'multi-enum',
          required: true,
          options: [
            { value: 'Logging', label: 'Logging' },
            { value: 'Tracing', label: 'Tracing' }
          ]
        }
      ]
    }
    render(<ElicitationPrompt request={generic} />)
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(mockRespond).not.toHaveBeenCalled()
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0])
    fireEvent.click(checkboxes[1])
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(mockRespond).toHaveBeenCalledWith('el-1', 'accept', {
      q1: ['Logging', 'Tracing']
    })
  })

  it('keeps the generic field loop for untitled forms', () => {
    const generic: PendingElicitation = {
      ...pending,
      fields: [
        {
          name: 'color',
          kind: 'enum',
          required: true,
          options: [
            { value: 'red', label: 'Red' },
            { value: 'blue', label: 'Blue' }
          ]
        }
      ]
    }
    render(<ElicitationPrompt request={generic} />)
    expect(screen.queryByTestId('elicitation-questions')).not.toBeInTheDocument()
    // Generic enum select still uses option value/label objects (GH-935).
    expect(screen.getByRole('option', { name: 'Red' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Blue' })).toBeInTheDocument()
  })
})
