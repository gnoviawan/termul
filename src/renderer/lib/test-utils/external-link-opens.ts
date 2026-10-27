import { type MockInstance, vi } from 'vitest'

/**
 * Counts every way a URL can leave the renderer in tests: the app's
 * `openerApi`, `window.open`, and the Tauri opener plugin's click listener.
 *
 * The listener mirrors tauri-plugin-opener 2.5.4 `init-iife.js`: the desktop
 * app injects a window click handler that sends any unprevented left click on
 * an `<a target="_blank">` (or a ctrl/shift click on any `<a>`) straight to
 * the OS browser. jsdom has no such listener, so a test that only spies on
 * `openerApi` would miss that channel.
 */
export interface ExternalOpenSpy {
  /** URLs that reached a browser, in order. */
  opens: () => string[]
  restore: () => void
}

export function spyOnExternalOpens(openerMock: { mock: { calls: unknown[][] } }): ExternalOpenSpy {
  const pluginOpens: string[] = []
  const onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey) return
    const anchor = event
      .composedPath()
      .find((el) => el instanceof Node && el.nodeName.toUpperCase() === 'A') as
      | HTMLAnchorElement
      | undefined
    if (!anchor?.href || !(anchor.target === '_blank' || event.ctrlKey || event.shiftKey)) return
    const url = new URL(anchor.href)
    if (['http:', 'https:', 'mailto:', 'tel:'].every((p) => url.protocol !== p)) return
    event.preventDefault()
    pluginOpens.push(url.href)
  }
  window.addEventListener('click', onClick)
  const windowOpen: MockInstance = vi.spyOn(window, 'open').mockImplementation(() => null)
  return {
    opens: () => [
      ...openerMock.mock.calls.map((call) => String(call[0])),
      ...pluginOpens,
      ...windowOpen.mock.calls.map((call) => String(call[0] ?? ''))
    ],
    restore: () => {
      window.removeEventListener('click', onClick)
      windowOpen.mockRestore()
    }
  }
}
