import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProjectBrowserSection } from './browser-section'

vi.mock('@/components/settings/BrowserPolicySettings', () => ({
  BrowserProjectPolicy: ({ projectId }: { projectId: string }) => <div>Rules for {projectId}</div>
}))

describe('ProjectBrowserSection', () => {
  it('shows the rules of the project that is open', () => {
    render(<ProjectBrowserSection projectId="p1" />)

    expect(screen.getByText('Rules for p1')).toBeInTheDocument()
  })

  it('asks for a project when none is open', () => {
    render(<ProjectBrowserSection projectId={undefined} />)

    expect(screen.getByText('Open a project to set its browser rules.')).toBeInTheDocument()
    expect(screen.queryByText(/^Rules for/)).not.toBeInTheDocument()
  })
})
