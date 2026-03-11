import '@testing-library/jest-dom'
import React from 'react'
import { vi } from 'vitest'

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  })
})

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserverMock

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  watchImmediate: vi.fn()
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
  message: vi.fn(),
  confirm: vi.fn()
}))

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(),
  writeText: vi.fn()
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  createStore: vi.fn()
}))

vi.mock('@tauri-apps/plugin-os', () => ({
  platform: vi.fn(),
  version: vi.fn(),
  type: vi.fn(),
  arch: vi.fn(),
  tempdir: vi.fn(),
  homedir: vi.fn()
}))

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: vi.fn(),
  open: vi.fn()
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
  revealItemInDir: vi.fn()
}))

vi.mock('react-virtuoso', () => {
  const VirtuosoComponent = React.forwardRef(
    (
      {
        data,
        itemContent
      }: {
        data: unknown[]
        itemContent: (index: number, item: unknown) => React.JSX.Element
      },
      _ref: React.Ref<unknown>
    ) => {
      return React.createElement(
        'div',
        { 'data-testid': 'virtuoso-scroller', 'data-virtuoso-scroller': 'true' },
        React.createElement(
          'div',
          { 'data-testid': 'virtuoso-item-list' },
          data.map((item, index) =>
            React.createElement('div', { key: index }, itemContent(index, item))
          )
        )
      )
    }
  )

  VirtuosoComponent.displayName = 'Virtuoso'

  return { Virtuoso: VirtuosoComponent }
})

