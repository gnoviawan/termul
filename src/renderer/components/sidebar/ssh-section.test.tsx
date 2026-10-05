import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SSHResizableSection } from './ssh-section'

// Issue #843: the SSH sidebar panel is a desktop-only surface. On web it must
// render nothing (not disabled rows), because connect/SFTP/port-forwarding
// are WEB_UNSUPPORTED there.
const { tauriRef } = vi.hoisted(() => ({ tauriRef: { current: true } }))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => tauriRef.current
}))

vi.mock('@/stores/ssh-panel-store', () => ({
  useSSHPanelVisible: () => true
}))

vi.mock('../ssh/SSHPanel', () => ({
  SSHPanel: () => <div data-testid="ssh-panel" />
}))

describe('SSHResizableSection web gating (#843)', () => {
  beforeEach(() => {
    tauriRef.current = true
  })

  it('renders the panel on desktop when visible', () => {
    const { container } = render(<SSHResizableSection />)

    expect(container.querySelector('[data-testid="ssh-panel"]')).not.toBeNull()
  })

  it('renders null on web even though the panel is toggled visible', () => {
    tauriRef.current = false

    const { container } = render(<SSHResizableSection />)
    expect(container.innerHTML).toBe('')
  })
})
