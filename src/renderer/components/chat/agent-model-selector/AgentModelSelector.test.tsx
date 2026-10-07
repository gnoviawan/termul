import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionConfigOption } from '@/lib/acp-api'
import { AgentModelSelector } from './AgentModelSelector'

function option(
  id: string,
  name: string,
  category: string,
  currentValue: string,
  options: Array<{ value: string; name: string }>
): SessionConfigOption {
  return { id, name, category, type: 'select', currentValue, options }
}

function renderSelector(
  overrides: Partial<Parameters<typeof AgentModelSelector>[0]> = {}
): ReturnType<typeof render> {
  return render(
    <AgentModelSelector
      sessionId="session-1"
      disabled={false}
      busy={false}
      modelOption={option('model', 'Model', 'model', 'opus', [
        { value: 'opus', name: 'Opus 5.5' },
        { value: 'sonnet', name: 'Sonnet 5.5' }
      ])}
      modelSource="config"
      thoughtLevel={option('reasoning', 'Thinking', 'thought_level', 'high', [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' }
      ])}
      fastMode={option('fast_mode', 'Fast Mode', 'other', 'off', [
        { value: 'on', name: 'On' },
        { value: 'off', name: 'Off' }
      ])}
      agentTemplateId="cursor"
      agentIcon={null}
      onSetConfig={vi.fn()}
      onSetModel={vi.fn()}
      {...overrides}
    />
  )
}

describe('AgentModelSelector', () => {
  it('toggles Fast through the agent option and keeps the row label', () => {
    const onSetConfig = vi.fn()
    renderSelector({ onSetConfig })

    fireEvent.click(screen.getByTestId('agent-model-selector-trigger'))
    const effort = screen.getByRole('button', { name: /^Effort,/ })
    expect(effort.className).toContain('hover:bg-foreground/10')
    expect(screen.getByText('Fast')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: 'Fast Mode' }))
    expect(onSetConfig).toHaveBeenCalledWith('fast_mode', 'on')
  })

  it('marks the active effort value and returns to the main card on select', async () => {
    const onSetConfig = vi.fn()
    renderSelector({ onSetConfig })

    fireEvent.click(screen.getByTestId('agent-model-selector-trigger'))
    fireEvent.click(screen.getByRole('button', { name: /^Effort,/ }))

    const high = screen.getByRole('button', { name: 'High' })
    expect(high).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Low' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Medium' }))
    expect(onSetConfig).toHaveBeenCalledWith('reasoning', 'medium')
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Medium' })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /^Effort, Medium/ })).toBeInTheDocument()
  })

  it('closes the effort flyout on Escape and the popover on the next Escape', async () => {
    renderSelector()
    fireEvent.click(screen.getByTestId('agent-model-selector-trigger'))

    const effort = screen.getByRole('button', { name: /^Effort,/ })
    effort.focus()
    fireEvent.keyDown(effort, { key: 'ArrowRight' })
    expect(screen.getByRole('button', { name: 'Low' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Low' })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /^Effort,/ })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Effort,/ })).not.toBeInTheDocument()
    })
  })

  it('dismisses the popover on an outside pointer', async () => {
    renderSelector()
    fireEvent.click(screen.getByTestId('agent-model-selector-trigger'))
    expect(screen.getByRole('button', { name: /^Effort,/ })).toBeInTheDocument()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    fireEvent.pointerDown(document.body, { button: 0 })
    fireEvent.click(document.body)

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Effort,/ })).not.toBeInTheDocument()
    })
  })
})
