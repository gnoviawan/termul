import '@testing-library/jest-dom'
import React from 'react'
import { afterEach, beforeEach, vi } from 'vitest'
import { initializeI18n } from './src/renderer/i18n'

await initializeI18n('en')

const storageValues = new WeakMap<Storage, Map<string, string>>()

function getStorageValues(storage: Storage): Map<string, string> {
  let values = storageValues.get(storage)
  if (!values) {
    values = new Map<string, string>()
    storageValues.set(storage, values)
  }
  return values
}

Object.defineProperties(Storage.prototype, {
  length: {
    configurable: true,
    get(this: Storage) {
      return getStorageValues(this).size
    }
  },
  clear: {
    configurable: true,
    value(this: Storage) {
      getStorageValues(this).clear()
    }
  },
  getItem: {
    configurable: true,
    value(this: Storage, key: string) {
      return getStorageValues(this).get(String(key)) ?? null
    }
  },
  key: {
    configurable: true,
    value(this: Storage, index: number) {
      return Array.from(getStorageValues(this).keys())[index] ?? null
    }
  },
  removeItem: {
    configurable: true,
    value(this: Storage, key: string) {
      getStorageValues(this).delete(String(key))
    }
  },
  setItem: {
    configurable: true,
    value(this: Storage, key: string, value: string) {
      getStorageValues(this).set(String(key), String(value))
    }
  }
})
const testLocalStorage: Storage = Object.create(Storage.prototype)
const testSessionStorage: Storage = Object.create(Storage.prototype)

function resetTestStorage(): void {
  storageValues.set(testLocalStorage, new Map<string, string>())
  storageValues.set(testSessionStorage, new Map<string, string>())
}

function installTestStorage(): void {
  const descriptors: PropertyDescriptorMap = {
    localStorage: {
      configurable: true,
      writable: true,
      value: testLocalStorage
    },
    sessionStorage: {
      configurable: true,
      writable: true,
      value: testSessionStorage
    }
  }
  Object.defineProperties(globalThis, descriptors)
  Object.defineProperties(window, descriptors)
}

resetTestStorage()
installTestStorage()
beforeEach(() => {
  resetTestStorage()
  installTestStorage()
})
afterEach(async () => {
  await initializeI18n('en')
  resetTestStorage()
  installTestStorage()
})

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

class IntersectionObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}

window.IntersectionObserver = IntersectionObserverMock as unknown as typeof IntersectionObserver

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {}))
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(),
  readFile: vi.fn(),
  readTextFile: vi.fn(),
  writeFile: vi.fn(),
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
  writeText: vi.fn(),
  readImage: vi.fn()
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
