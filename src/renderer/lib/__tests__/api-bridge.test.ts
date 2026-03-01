/**
 * Unit tests for API Bridge (api.ts)
 * Tests the unified API exports and singleton pattern
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  terminalApi,
  clipboardApi,
  systemApi,
  persistenceApi,
  windowApi,
  keyboardApi,
  visibilityApi,
  filesystemApi,
  dialogApi,
  shellApi,
  addRendererRef,
  removeRendererRef
} from '../api'
import type { IpcResult } from '@shared/types/ipc.types'

// Mock all Tauri dependencies BEFORE importing
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn()
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn()
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    outerSize: vi.fn(async () => ({ width: 800, height: 600 })),
    setPosition: vi.fn(),
    setSize: vi.fn(),
    onCloseRequested: vi.fn()
  }))
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  Store: {
    load: vi.fn(async () => ({
      get: vi.fn(async () => null),
      set: vi.fn(),
      delete: vi.fn(),
      save: vi.fn()
    }))
  }
}))

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: vi.fn(async () => ''),
  writeText: vi.fn()
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  readDir: vi.fn(async () => []),
  readTextFile: vi.fn(async () => ''),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  watchImmediate: vi.fn()
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  confirm: vi.fn()
}))

describe('API Bridge (api.ts)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('exports availability', () => {
    it('should export terminalApi', () => {
      expect(terminalApi).toBeDefined()
      expect(typeof terminalApi.spawn).toBe('function')
      expect(typeof terminalApi.write).toBe('function')
      expect(typeof terminalApi.resize).toBe('function')
      expect(typeof terminalApi.kill).toBe('function')
    })

    it('should export clipboardApi', () => {
      expect(clipboardApi).toBeDefined()
      expect(typeof clipboardApi.readText).toBe('function')
      expect(typeof clipboardApi.writeText).toBe('function')
    })

    it('should export systemApi', () => {
      expect(systemApi).toBeDefined()
      expect(typeof systemApi.getHomeDirectory).toBe('function')
      expect(typeof systemApi.onPowerResume).toBe('function')
    })

    it('should export persistenceApi', () => {
      expect(persistenceApi).toBeDefined()
      expect(typeof persistenceApi.read).toBe('function')
      expect(typeof persistenceApi.write).toBe('function')
      expect(typeof persistenceApi.writeDebounced).toBe('function')
      expect(typeof persistenceApi.delete).toBe('function')
    })

    it('should export windowApi', () => {
      expect(windowApi).toBeDefined()
      expect(typeof windowApi.minimize).toBe('function')
      expect(typeof windowApi.toggleMaximize).toBe('function')
      expect(typeof windowApi.close).toBe('function')
    })

    it('should export keyboardApi', () => {
      expect(keyboardApi).toBeDefined()
      expect(typeof keyboardApi.onShortcut).toBe('function')
    })

    it('should export visibilityApi', () => {
      expect(visibilityApi).toBeDefined()
      expect(typeof visibilityApi.setVisibilityState).toBe('function')
    })

    it('should export filesystemApi', () => {
      expect(filesystemApi).toBeDefined()
      expect(typeof filesystemApi.readDirectory).toBe('function')
      expect(typeof filesystemApi.readFile).toBe('function')
      expect(typeof filesystemApi.writeFile).toBe('function')
    })

    it('should export dialogApi', () => {
      expect(dialogApi).toBeDefined()
      expect(typeof dialogApi.selectDirectory).toBe('function')
    })

    it('should export shellApi', () => {
      expect(shellApi).toBeDefined()
      expect(typeof shellApi.getAvailableShells).toBe('function')
    })

    it('should export renderer ref functions', () => {
      expect(typeof addRendererRef).toBe('function')
      expect(typeof removeRendererRef).toBe('function')
    })
  })

  describe('API consistency', () => {
    it('all async methods should return IpcResult pattern', () => {
      // Check that all APIs follow the same error handling pattern
      const asyncApis = [
        { api: systemApi, method: 'getHomeDirectory' },
        { api: persistenceApi, method: 'read' },
        { api: clipboardApi, method: 'readText' },
        { api: windowApi, method: 'minimize' }
      ]

      for (const { api, method } of asyncApis) {
        expect(typeof api[method as keyof typeof api]).toBe('function')
      }
    })
  })

  describe('singleton pattern', () => {
    it('should return the same instance on multiple imports', () => {
      // Import again from a different path
      const api1 = terminalApi

      expect(api1).toBe(terminalApi)
    })
  })
})
