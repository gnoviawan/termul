import type { SSHProfile } from '@shared/types/ssh.types'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SSH_HOSTS_TAB, type SSHSession } from '@/stores/ssh-store'
import { SSHSessionTabs, sessionLabels } from './SSHSessionTabs'

const profiles = [
  { id: 'a', name: 'web' },
  { id: 'b', name: 'db' }
] as SSHProfile[]

const session = (id: string, profileId: string, status: SSHSession['status'] = 'connected') =>
  ({ id, profileId, status }) as SSHSession

describe('sessionLabels', () => {
  it('numbers a host open in several tabs and marks removed hosts', () => {
    const labels = sessionLabels(
      [session('1', 'a'), session('2', 'b'), session('3', 'a'), session('4', 'gone')],
      profiles
    )
    expect([...labels.values()]).toEqual(['web (1)', 'db', 'web (2)', 'Removed host'])
  })
})

describe('SSHSessionTabs', () => {
  it('names each tab with its state, closes with Delete and middle-click', () => {
    const onClose = vi.fn()
    const onSelect = vi.fn()
    render(
      <SSHSessionTabs
        sessions={[session('1', 'a', 'awaitingInput'), session('2', 'b', 'failed')]}
        profiles={profiles}
        activeTab="1"
        onSelect={onSelect}
        onClose={onClose}
      />
    )
    const web = screen.getByRole('tab', { name: 'web, Needs input' })
    expect(web).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tab', { name: 'Hosts' })).toHaveAttribute('tabindex', '-1')
    fireEvent.keyDown(web, { key: 'Delete' })
    expect(onClose).toHaveBeenCalledWith('1')
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'db, Failed' }), { button: 1 })
    expect(onClose).toHaveBeenCalledWith('2')
    fireEvent.keyDown(web, { key: 'Home' })
    expect(onSelect).toHaveBeenCalledWith(SSH_HOSTS_TAB)
  })
})
