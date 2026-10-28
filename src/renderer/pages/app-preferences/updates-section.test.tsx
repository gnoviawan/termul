import { fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { UpdatesSection } from './updates-section'

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: () => true
}))

type Props = ComponentProps<typeof UpdatesSection>

function renderSection(overrides: Partial<Props> = {}): Props {
  const props: Props = {
    isAurUpdater: false,
    isChecking: false,
    updateAvailable: false,
    version: null,
    lastChecked: null,
    autoUpdateEnabled: true,
    skippedVersion: null,
    updateError: null,
    updateErrorSource: null,
    isManualUpdateMode: false,
    updateChannel: 'stable',
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    installAndRestart: vi.fn(),
    handleAutoUpdateToggle: vi.fn(),
    setUpdateChannel: vi.fn(),
    ...overrides
  }
  render(<UpdatesSection {...props} />)
  return props
}

describe('UpdatesSection update mode copy', () => {
  it('describes nightly updates as signed in-app installs', () => {
    renderSection({ updateChannel: 'nightly' })

    expect(screen.getByText(/Updates are signed and install in the app\./)).toBeTruthy()
    expect(screen.queryByText(/manual download/)).toBeNull()
  })

  it('describes nightly updates as a manual download once the check fell back', () => {
    renderSection({
      updateChannel: 'nightly',
      isManualUpdateMode: true,
      updateAvailable: true,
      version: '0.5.0-nightly.20261028.101.bbbbbbb'
    })

    expect(
      screen.getByText(/Updates are offered as a manual download from the nightly release page\./)
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open download page/ })).toBeTruthy()
  })

  it('shows the in-app notice without a download-page button for a signed nightly update', () => {
    renderSection({
      updateChannel: 'nightly',
      updateAvailable: true,
      version: '0.5.0-nightly.20261028.101.bbbbbbb'
    })

    expect(screen.getByText(/A new version is ready to download\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Open download page/ })).toBeNull()
  })

  it('keeps insider on the manual-download copy', () => {
    renderSection({ updateChannel: 'insider' })

    expect(
      screen.getByText(/Updates are offered as a manual download from the insider release page\./)
    ).toBeTruthy()
  })
})

describe('UpdatesSection error copy', () => {
  it('reports a failed check as a check failure', () => {
    renderSection({ updateError: 'network down', updateErrorSource: 'check' })

    expect(screen.getByText(/Termul could not check for updates\./)).toBeTruthy()
  })

  it('reports a failed download as a download failure, not a check failure', () => {
    renderSection({ updateError: 'signature mismatch', updateErrorSource: 'download' })

    expect(screen.getByText(/Termul could not download the update\./)).toBeTruthy()
    expect(screen.queryByText(/could not check for updates/)).toBeNull()
  })

  it('reports a failed install as an install failure, not a check failure', () => {
    renderSection({ updateError: 'install failed', updateErrorSource: 'install' })

    expect(screen.getByText(/Termul could not install the update\./)).toBeTruthy()
    expect(screen.queryByText(/could not check for updates/)).toBeNull()
  })
})

describe('UpdatesSection error retry', () => {
  function clickTryAgain(): void {
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }))
  }

  it('retries the check after a failed check', () => {
    const props = renderSection({ updateError: 'network down', updateErrorSource: 'check' })

    clickTryAgain()

    expect(props.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(props.downloadUpdate).not.toHaveBeenCalled()
    expect(props.installAndRestart).not.toHaveBeenCalled()
  })

  it('retries the download after a failed download', () => {
    const props = renderSection({
      updateError: 'signature mismatch',
      updateErrorSource: 'download'
    })

    clickTryAgain()

    expect(props.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(props.checkForUpdates).not.toHaveBeenCalled()
  })

  it('retries the install after a failed install', () => {
    const props = renderSection({ updateError: 'install failed', updateErrorSource: 'install' })

    clickTryAgain()

    expect(props.installAndRestart).toHaveBeenCalledTimes(1)
    expect(props.checkForUpdates).not.toHaveBeenCalled()
  })
})
