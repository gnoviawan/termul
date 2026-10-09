import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElicitationField } from '@/lib/acp-api'
import type { PendingElicitation } from '@/stores/acp-store'

const { mobileRef, respondElicitation, toastError } = vi.hoisted(() => ({
  mobileRef: { current: false },
  respondElicitation: vi.fn(async () => {}),
  toastError: vi.fn()
}))

vi.mock('@/hooks/use-mobile-web-shell', () => ({
  useMobileWebShell: () => mobileRef.current
}))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/lib/api', () => ({ openerApi: { openUrlWithSystemBrowser: vi.fn() } }))
vi.mock('@/stores/acp-store', () => ({
  useAcpStore: (selector: (s: { respondElicitation: typeof respondElicitation }) => unknown) =>
    selector({ respondElicitation })
}))

import { ElicitationPrompt } from './ElicitationPrompt'

function field(name: string, kind: string, overrides: Partial<ElicitationField> = {}) {
  return { name, kind, required: false, options: [], ...overrides } as ElicitationField
}

function request(
  fields: ElicitationField[],
  overrides: Partial<PendingElicitation> = {}
): PendingElicitation {
  return {
    requestId: 'el-1',
    agentId: 'agent-1',
    sessionId: 's1',
    mode: 'form',
    message: 'Configure the deploy',
    fields,
    ...overrides
  }
}

const FORM = [
  field('title', 'string', { required: true }),
  field('region', 'enum', {
    options: [
      { value: 'eu', label: 'eu' },
      { value: 'us', label: 'us' }
    ],
    required: true
  }),
  field('notify', 'boolean', { required: true })
]

describe('ElicitationPrompt', () => {
  beforeEach(() => {
    mobileRef.current = false
    respondElicitation.mockReset().mockResolvedValue(undefined)
    toastError.mockReset()
  })

  describe('desktop baseline', () => {
    it('renders the message as plain text, keeps the heading unfocusable and never moves focus', () => {
      render(<ElicitationPrompt request={request(FORM)} autoFocusHeading />)

      const heading = screen.getByRole('heading', { level: 2, name: 'Request from the agent' })
      expect(heading).not.toHaveAttribute('tabindex')
      expect(heading).not.toHaveClass('outline-none')
      expect(screen.getByText('Configure the deploy').tagName).toBe('P')
      expect(screen.getByRole('dialog')).not.toHaveAttribute('tabindex')
      expect(document.body).toHaveFocus()
      expect(screen.getByTestId('elicitation-prompt')).toHaveAttribute(
        'data-approval-prompt',
        'elicitation:el-1'
      )
    })

    it('keeps the shipped fields and small buttons without aria-required', () => {
      render(<ElicitationPrompt request={request(FORM)} />)

      expect(screen.getByRole('checkbox')).toBeInTheDocument()
      expect(screen.queryByRole('switch')).not.toBeInTheDocument()
      expect(screen.getByRole('combobox')).toHaveClass('text-sm')
      expect(screen.getByRole('combobox')).not.toHaveClass('min-h-11')
      expect(screen.getByRole('textbox')).not.toHaveClass('h-11')
      for (const el of [screen.getByRole('textbox'), screen.getByRole('combobox')]) {
        expect(el).not.toHaveAttribute('aria-required')
      }
      expect(screen.getByRole('button', { name: 'Submit' })).toHaveClass('h-9')
      expect(screen.getByRole('button', { name: 'Submit' }).parentElement).toHaveClass('gap-2')
    })

    it('reports a missing required field with a toast only', () => {
      render(<ElicitationPrompt request={request(FORM)} />)
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

      expect(toastError).toHaveBeenCalledWith('title is required.')
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(respondElicitation).not.toHaveBeenCalled()
      expect(document.body).toHaveFocus()
    })
  })

  describe('mobile shell', () => {
    beforeEach(() => {
      mobileRef.current = true
    })

    it('renders the request heading as a focusable h2 and focuses it at mount', () => {
      render(<ElicitationPrompt request={request(FORM)} autoFocusHeading />)

      const heading = screen.getByRole('heading', { level: 2, name: 'Request from the agent' })
      expect(heading).toHaveAttribute('tabindex', '-1')
      expect(heading).toHaveClass('outline-none')
      expect(heading).toHaveFocus()
      expect(screen.getByTestId('elicitation-prompt')).toHaveAttribute(
        'data-approval-prompt',
        'elicitation:el-1'
      )
    })

    it('does not focus the heading when the pane is hidden at mount, nor when the prop flips later', () => {
      const { rerender } = render(
        <ElicitationPrompt request={request(FORM)} autoFocusHeading={false} />
      )
      expect(screen.getByRole('heading', { level: 2 })).not.toHaveFocus()

      rerender(<ElicitationPrompt request={request(FORM)} autoFocusHeading />)
      expect(screen.getByRole('heading', { level: 2 })).not.toHaveFocus()
    })

    it('sizes buttons and fields for touch', () => {
      render(<ElicitationPrompt request={request(FORM)} />)

      for (const name of ['Cancel', 'Decline', 'Submit']) {
        const button = screen.getByRole('button', { name })
        expect(button).toHaveClass('h-11')
        expect(button).not.toHaveClass('h-9')
      }
      expect(screen.getByRole('button', { name: 'Submit' }).parentElement).toHaveClass('gap-3')

      const input = screen.getByRole('textbox')
      expect(input).toHaveClass('h-11', 'md:text-base')
      const select = screen.getByRole('combobox')
      expect(select).toHaveClass('min-h-11', 'text-base')
      expect(select).not.toHaveClass('text-sm')
    })

    it('renders a boolean as a Switch in a min-h-11 label row', () => {
      render(<ElicitationPrompt request={request(FORM)} />)

      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
      const toggle = screen.getByRole('switch', { name: 'notify' })
      expect(toggle.closest('label')).toHaveClass('min-h-11')
      expect(toggle).toHaveAttribute('aria-checked', 'false')
      fireEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-checked', 'true')
    })

    it('marks required fields with aria-required, and optional ones without', () => {
      render(
        <ElicitationPrompt
          request={request([field('title', 'string', { required: true }), field('note', 'string')])}
        />
      )
      const [title, note] = screen.getAllByRole('textbox')
      expect(title).toHaveAttribute('aria-required', 'true')
      expect(note).not.toHaveAttribute('aria-required')

      render(<ElicitationPrompt request={request(FORM)} />)
      expect(screen.getByRole('combobox')).toHaveAttribute('aria-required', 'true')
      expect(screen.getByRole('switch')).toHaveAttribute('aria-required', 'true')
    })

    it('toasts and shows the same text inline, flags and focuses the empty required field', () => {
      render(<ElicitationPrompt request={request(FORM)} />)
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

      expect(toastError).toHaveBeenCalledWith('title is required.')
      const alert = screen.getByRole('alert')
      expect(alert).toHaveTextContent('title is required.')

      const title = screen.getByRole('textbox')
      expect(title).toHaveAttribute('aria-invalid', 'true')
      expect(title).toHaveAttribute('aria-describedby', alert.id)
      expect(title).toHaveFocus()
      expect(respondElicitation).not.toHaveBeenCalled()
    })

    it('clears the inline error when the field changes', () => {
      render(<ElicitationPrompt request={request(FORM)} />)
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
      expect(screen.getByRole('alert')).toBeInTheDocument()

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Release' } })

      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-invalid')
      expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-describedby')
    })

    it('flags the Switch for a required boolean and the select for a required enum', () => {
      render(<ElicitationPrompt request={request(FORM.slice(1))} />)

      fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
      expect(screen.getByRole('alert')).toHaveTextContent('region is required.')
      expect(screen.getByRole('combobox')).toHaveFocus()

      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'eu' } })
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
      expect(screen.getByRole('alert')).toHaveTextContent('notify is required.')
      expect(screen.getByRole('switch')).toHaveFocus()
      expect(screen.getByRole('switch')).toHaveAttribute('aria-invalid', 'true')
    })

    it('shows number validation inline too', () => {
      render(<ElicitationPrompt request={request([field('count', 'integer')])} />)
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1.5' } })
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

      expect(toastError).toHaveBeenCalledWith('count must be a whole number.')
      expect(screen.getByRole('alert')).toHaveTextContent('count must be a whole number.')
      expect(screen.getByRole('spinbutton')).toHaveFocus()
    })

    it('submits a valid form once, with the entered content', () => {
      render(<ElicitationPrompt request={request(FORM)} />)
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Release' } })
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'us' } })
      fireEvent.click(screen.getByRole('switch'))
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(respondElicitation).toHaveBeenCalledTimes(1)
      expect(respondElicitation).toHaveBeenCalledWith('el-1', 'accept', {
        title: 'Release',
        region: 'us',
        notify: true
      })
    })

    it('still routes Cancel and Decline through respondElicitation', () => {
      render(<ElicitationPrompt request={request(FORM)} />)
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }))
      expect(respondElicitation).toHaveBeenLastCalledWith('el-1', 'decline', undefined)
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(respondElicitation).toHaveBeenLastCalledWith('el-1', 'cancel', undefined)
    })

    it('makes the "Open link" button touch sized for a url request', () => {
      render(
        <ElicitationPrompt
          request={request([], { mode: 'url', url: 'https://example.com/consent' })}
        />
      )
      expect(screen.getByRole('button', { name: 'Open link' })).toHaveClass('h-11')
      expect(screen.getByRole('button', { name: 'Done' })).toHaveClass('h-11')
    })
  })

  describe('titled and multi-select fields on the mobile shell', () => {
    const COLORS = [
      { value: 'Red', label: 'Red' },
      { value: 'Blue', label: 'Blue' }
    ]

    beforeEach(() => {
      mobileRef.current = true
    })

    it('shows the title and description, and keeps them beside a boolean Switch', () => {
      render(
        <ElicitationPrompt
          request={request([
            field('notify', 'boolean', {
              title: 'Notify the team',
              description: 'Posts to the release channel'
            })
          ])}
        />
      )

      const toggle = screen.getByRole('switch', { name: /Notify the team/ })
      const row = toggle.closest('label')
      expect(row).toHaveClass('flex', 'min-h-11')
      expect(row).toHaveTextContent('Posts to the release channel')
    })

    it('names a missing required field by its title in the toast and the inline alert', () => {
      render(
        <ElicitationPrompt
          request={request([field('q0', 'string', { required: true, title: 'Release name' })])}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

      expect(toastError).toHaveBeenCalledWith('Release name is required.')
      expect(screen.getByRole('alert')).toHaveTextContent('Release name is required.')
      expect(screen.getByRole('textbox')).toHaveFocus()
    })

    it('gives multi-select rows a touch height and flags the first checkbox when none is picked', () => {
      render(
        <ElicitationPrompt
          request={request([field('colors', 'multi-enum', { required: true, options: COLORS })])}
        />
      )
      const [red, blue] = screen.getAllByRole('checkbox')
      expect(red.parentElement).toHaveClass('min-h-11')
      expect(blue.parentElement).toHaveClass('min-h-11')

      fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
      expect(screen.getByRole('alert')).toHaveTextContent('colors is required.')
      expect(red).toHaveFocus()
      expect(red).toHaveAttribute('aria-invalid', 'true')

      fireEvent.click(blue)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
      expect(respondElicitation).toHaveBeenCalledWith('el-1', 'accept', { colors: ['Blue'] })
    })
  })

  describe('question batch (GH-935)', () => {
    const QUESTIONS = [
      field('q0', 'enum', {
        required: true,
        title: 'Color',
        description: 'Which color should I use?',
        options: [
          { value: 'Red', label: 'Red' },
          { value: 'Blue', label: 'Blue' }
        ]
      })
    ]

    it('focuses the dialog on mobile and shows a non-repeat message as the stepper note', () => {
      mobileRef.current = true
      render(
        <ElicitationPrompt
          request={request(QUESTIONS, { message: 'A quick batch of questions' })}
          autoFocusHeading
        />
      )

      const dialog = screen.getByRole('dialog', { name: 'A quick batch of questions' })
      expect(dialog).toHaveFocus()
      expect(screen.getByText('A quick batch of questions').tagName).toBe('P')
      expect(screen.getByTestId('elicitation-questions')).toBeInTheDocument()
    })

    it('focuses the dialog itself on mobile when the message repeats a question', () => {
      mobileRef.current = true
      render(
        <ElicitationPrompt
          request={request(QUESTIONS, { message: 'Which color should I use?' })}
          autoFocusHeading
        />
      )

      expect(screen.queryByText('Which color should I use?', { selector: 'p' })).toBeNull()
      const dialog = screen.getByRole('dialog', { name: 'Which color should I use?' })
      expect(dialog).toHaveAttribute('tabindex', '-1')
      expect(dialog).toHaveClass('outline-none')
      expect(dialog).toHaveFocus()
    })

    it('does not move focus when the pane is hidden at mount', () => {
      mobileRef.current = true
      render(
        <ElicitationPrompt request={request(QUESTIONS, { message: 'Which color should I use?' })} />
      )

      expect(screen.getByRole('dialog')).not.toHaveFocus()
      expect(document.body).toHaveFocus()
    })

    it('leaves the desktop dialog unfocusable and unfocused, and the message a paragraph', () => {
      render(
        <ElicitationPrompt
          request={request(QUESTIONS, { message: 'A quick batch of questions' })}
          autoFocusHeading
        />
      )

      expect(screen.getByRole('dialog')).not.toHaveAttribute('tabindex')
      expect(screen.getByText('A quick batch of questions').tagName).toBe('P')
      expect(document.body).toHaveFocus()
    })

    it('still submits the picked answers through respondElicitation', () => {
      mobileRef.current = true
      render(<ElicitationPrompt request={request(QUESTIONS)} />)

      fireEvent.click(screen.getByRole('button', { name: /Blue/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

      expect(respondElicitation).toHaveBeenCalledWith('el-1', 'accept', { q0: 'Blue' })
    })
  })
})
