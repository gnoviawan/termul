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

Object.defineProperty(window, 'devicePixelRatio', {
  writable: true,
  value: 1,
})

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserverMock

const createCanvas2DContextMock = () => ({
  canvas: { width: 1, height: 1 },
  font: '',
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 1,
  save: () => {},
  restore: () => {},
  scale: () => {},
  translate: () => {},
  beginPath: () => {},
  closePath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  rect: () => {},
  fillRect: () => {},
  clearRect: () => {},
  strokeRect: () => {},
  fillText: () => {},
  strokeText: () => {},
  setLineDash: () => {},
  measureText: (text: string) => ({
    width: Math.max(1, text.length * 8),
    actualBoundingBoxAscent: 8,
    actualBoundingBoxDescent: 2,
    fontBoundingBoxAscent: 8,
    fontBoundingBoxDescent: 2,
  }),
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  putImageData: () => {},
  createImageData: () => ({ data: new Uint8ClampedArray(4) }),
})

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  writable: true,
  value: () => createCanvas2DContextMock(),
})

class OffscreenCanvasMock {
  width: number
  height: number

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  getContext() {
    return createCanvas2DContextMock()
  }
}

Object.defineProperty(globalThis, 'OffscreenCanvas', {
  writable: true,
  value: OffscreenCanvasMock,
})

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

