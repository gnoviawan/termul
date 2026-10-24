import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetNativeWebviewOcclusionForTests,
  useNativeWebviewOccluded
} from '@/hooks/use-native-webview-occlusion'
import { SettingsModal } from './SettingsModal'

vi.mock('@/lib/tauri-runtime', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tauri-runtime')>('@/lib/tauri-runtime')
  return { ...actual, isTauriContext: () => true }
})

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.closest('[hidden]')) return [] as unknown as DOMRectList
    return [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SettingsModal Tab trap', () => {
  it('wraps Tab among visible controls and skips a hidden page', () => {
    render(
      <SettingsModal isOpen onClose={() => undefined} title="Preferences">
        <button type="button">First</button>
        <section hidden>
          <button type="button">Hidden</button>
        </section>
        <button type="button">Last</button>
      </SettingsModal>
    )

    const first = screen.getByRole('button', { name: 'First' })
    const last = screen.getByRole('button', { name: 'Last' })
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(first).toHaveFocus()

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
  })
})

describe('SettingsModal Escape', () => {
  function renderWith(recorder: ReactNode) {
    const onClose = vi.fn()
    render(
      <SettingsModal isOpen onClose={onClose} title="Preferences">
        {recorder}
      </SettingsModal>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    return onClose
  }

  it('closes while an idle shortcut recorder is mounted', () => {
    const onClose = renderWith(<div data-shortcut-recorder="true" />)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open while a shortcut recorder is recording', () => {
    const onClose = renderWith(<div data-shortcut-recorder="true" data-recording="true" />)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('SettingsModal and browser-pane webviews', () => {
  function Probe(): React.JSX.Element {
    return <output>{useNativeWebviewOccluded() ? 'hidden' : 'shown'}</output>
  }

  it('hides native webviews while open and reveals them on close', () => {
    resetNativeWebviewOcclusionForTests()
    const view = render(
      <>
        <Probe />
        <SettingsModal isOpen onClose={() => undefined} title="Preferences">
          <button type="button">First</button>
        </SettingsModal>
      </>
    )
    expect(screen.getByRole('status')).toHaveTextContent('hidden')

    view.rerender(
      <>
        <Probe />
        <SettingsModal isOpen={false} onClose={() => undefined} title="Preferences">
          <button type="button">First</button>
        </SettingsModal>
      </>
    )
    expect(screen.getByRole('status')).toHaveTextContent('shown')
  })
})
