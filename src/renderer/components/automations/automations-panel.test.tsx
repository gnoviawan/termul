import type { Automation, AutomationId } from '@shared/types/automation.types'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { automationWith, detailWith } from '@/lib/test-utils/automation-fixtures'

const phone = vi.hoisted(() => ({ current: false }))
const hosted = vi.hoisted(() => ({ automations: [] as Automation[] }))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/hooks/use-mobile-web-shell', () => ({ useMobileWebShell: () => phone.current }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn(async () => {}) }))
vi.mock('@/lib/automation-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/automation-api')>()
  const ok = <T,>(data: T) => Promise.resolve({ success: true as const, data })
  return {
    ...actual,
    listAutomations: vi.fn(() => ok(hosted.automations)),
    getAutomation: vi.fn((id: AutomationId) => {
      const automation = hosted.automations.find((candidate) => candidate.id === id)
      return automation
        ? ok(detailWith(automation))
        : Promise.resolve({ success: false as const, error: 'automation not found' })
    }),
    listAutomationRuns: vi.fn(() => ok([])),
    markAutomationSeen: vi.fn(() => ok(undefined))
  }
})

import { publishAutomationChange } from '@/lib/automation-api'
import { AutomationsPanel } from './AutomationsPanel'

const first = automationWith({ id: 'auto-1' as AutomationId, name: 'Morning digest' })
const second = automationWith({ id: 'auto-2' as AutomationId, name: 'Open PR summary' })

function deleteSecondElsewhere(): void {
  hosted.automations = [first]
  act(() => publishAutomationChange({ project_id: 'p1', automation_id: 'auto-2' }))
}

beforeEach(() => {
  phone.current = false
  hosted.automations = [first, second]
})

describe('AutomationsPanel', () => {
  it('falls back to the first automation when the chosen one is deleted elsewhere', async () => {
    render(<AutomationsPanel projectId="p1" isVisible />)
    fireEvent.click(await screen.findByRole('button', { name: /Open PR summary/ }))
    expect(await screen.findByRole('heading', { name: 'Open PR summary' })).toBeInTheDocument()

    deleteSecondElsewhere()

    expect(await screen.findByRole('heading', { name: 'Morning digest' })).toBeInTheDocument()
    expect(screen.queryByText(/Could not load it/)).toBeNull()
  })

  it('on the phone, returns to the list when the open automation is deleted elsewhere', async () => {
    phone.current = true
    render(<AutomationsPanel projectId="p1" isVisible />)
    fireEvent.click(await screen.findByRole('button', { name: /Open PR summary/ }))
    expect(await screen.findByRole('heading', { name: 'Open PR summary' })).toBeInTheDocument()

    deleteSecondElsewhere()

    expect(await screen.findByRole('button', { name: /Morning digest/ })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Open PR summary' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Automations' })).toBeNull()
  })
})
