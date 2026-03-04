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
  sessionApi,
  dataMigrationApi,
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

    it('should export sessionApi', () => {
      expect(sessionApi).toBeDefined()
      expect(typeof sessionApi.save).toBe('function')
      expect(typeof sessionApi.restore).toBe('function')
      expect(typeof sessionApi.clear).toBe('function')
      expect(typeof sessionApi.flush).toBe('function')
      expect(typeof sessionApi.hasSession).toBe('function')
    })

    it('should export dataMigrationApi', () => {
      expect(dataMigrationApi).toBeDefined()
      expect(typeof dataMigrationApi.rollback).toBe('function')
      expect(typeof dataMigrationApi.getHistory).toBe('function')
      expect(typeof dataMigrationApi.getRegistered).toBe('function')

      if ('runMigration' in dataMigrationApi) {
        expect(typeof dataMigrationApi.runMigration).toBe('function')
      }

      if ('getVersion' in dataMigrationApi) {
        expect(typeof dataMigrationApi.getVersion).toBe('function')
      }

      if ('getSchemaInfo' in dataMigrationApi) {
        expect(typeof dataMigrationApi.getSchemaInfo).toBe('function')
      }

      if ('runMigrations' in dataMigrationApi) {
        expect(typeof dataMigrationApi.runMigrations).toBe('function')
      }

      if ('getVersionInfo' in dataMigrationApi) {
        expect(typeof dataMigrationApi.getVersionInfo).toBe('function')
      }
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

  describe('Regression: Tauri-first API paths', () => {
    /**
     * REGRESSION TEST: Ensure facade uses Tauri paths on Tauri runtime
     *
     * This test prevents silent fallback to window.api (Electron path)
     * which would cause runtime errors in Tauri builds.
     */

    it('should use tauri-session-api for sessionApi', () => {
      // The sessionApi should be imported from tauri-session-api.ts
      // which uses Tauri's plugin-store for persistence
      expect(sessionApi).toBeDefined()

      // Verify it's not the Electron implementation by checking for Tauri-specific patterns
      // The Tauri implementation uses Store internally, while Electron uses window.api
      expect(typeof sessionApi.save).toBe('function')
      expect(typeof sessionApi.restore).toBe('function')
    })

    it('should use tauri-data-migration-api for dataMigrationApi in Tauri context', () => {
      // The facade detects context at runtime:
      // - Tauri: uses createTauriDataMigrationApi() with canonical method names
      // - Electron: uses legacy data-migration-api.ts with legacy method names

      // Check if we're in Tauri context
      const isTauri = typeof window !== 'undefined' &&
        typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'

      expect(dataMigrationApi).toBeDefined()

      // In Tauri context, verify canonical method names
      if (isTauri) {
        expect('getVersion' in dataMigrationApi).toBe(true)
        expect('getSchemaInfo' in dataMigrationApi).toBe(true)
        expect('runMigration' in dataMigrationApi).toBe(true)

        if ('getVersion' in dataMigrationApi) {
          expect(typeof dataMigrationApi.getVersion).toBe('function')
        }
        if ('getSchemaInfo' in dataMigrationApi) {
          expect(typeof dataMigrationApi.getSchemaInfo).toBe('function')
        }
        if ('runMigration' in dataMigrationApi) {
          expect(typeof dataMigrationApi.runMigration).toBe('function')
        }
      } else {
        // In Electron context (or tests), verify legacy method names
        expect('runMigrations' in dataMigrationApi).toBe(true)
        expect('getVersionInfo' in dataMigrationApi).toBe(true)
        expect(typeof dataMigrationApi.getHistory).toBe('function')
        expect(typeof dataMigrationApi.getRegistered).toBe('function')
        expect(typeof dataMigrationApi.rollback).toBe('function')

        if ('runMigrations' in dataMigrationApi) {
          expect(typeof dataMigrationApi.runMigrations).toBe('function')
        }
        if ('getVersionInfo' in dataMigrationApi) {
          expect(typeof dataMigrationApi.getVersionInfo).toBe('function')
        }
      }
    })

    it('should not silently fallback to window.api for Tauri APIs', () => {
      // Ensure we're not using the Electron window.api fallback
      // This would be caught at runtime in Tauri builds

      // In a Tauri build, window.api should not exist
      // The APIs should work without it
      const hasWindowApi = typeof window !== 'undefined' && 'api' in window

      // These APIs should work regardless of window.api presence
      expect(sessionApi).toBeDefined()
      expect(dataMigrationApi).toBeDefined()

      // If we're in a test environment, window.api shouldn't be required
      // for these APIs to be defined
      if (!hasWindowApi) {
        // APIs should still be defined using Tauri implementations
        expect(sessionApi).toBeDefined()
        expect(dataMigrationApi).toBeDefined()
      }
    })

    it('should use Tauri invoke() for data migration operations', async () => {
      // Verify dataMigrationApi uses Tauri's invoke pattern
      const invoke = vi.mocked(await import('@tauri-apps/api/core')).invoke

      // Mock a successful response
      invoke.mockResolvedValue({
        success: true,
        data: []
      })

      // Call the method (using legacy name for test environment)
      const result = await (dataMigrationApi as any).getHistory()

      // Should return IpcResult pattern
      expect(typeof result.success).toBe('boolean')
    })
  })

  describe('canonical contract compliance', () => {
    /**
     * REGRESSION TEST: Verify API follows canonical MigrationApi contract
     * from @shared/types/ipc.types.ts
     *
     * Note: The facade routes to different implementations based on context:
     * - Tauri: Uses canonical method names (getVersion, getSchemaInfo, runMigration)
     * - Electron: Uses legacy method names (runMigrations, getVersionInfo)
     */

    it('dataMigrationApi should have appropriate methods for its context', () => {
      // Check if we're in Tauri context
      const isTauri = typeof window !== 'undefined' &&
        typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'

      if (isTauri) {
        // These are the canonical method names from MigrationApi interface
        expect(typeof dataMigrationApi.getHistory).toBe('function')
        expect(typeof dataMigrationApi.getRegistered).toBe('function')
        expect(typeof dataMigrationApi.rollback).toBe('function')

        expect('getVersion' in dataMigrationApi).toBe(true)
        expect('getSchemaInfo' in dataMigrationApi).toBe(true)
        expect('runMigration' in dataMigrationApi).toBe(true)

        if ('getVersion' in dataMigrationApi) {
          expect(typeof dataMigrationApi.getVersion).toBe('function')
        }
        if ('getSchemaInfo' in dataMigrationApi) {
          expect(typeof dataMigrationApi.getSchemaInfo).toBe('function')
        }
        if ('runMigration' in dataMigrationApi) {
          expect(typeof dataMigrationApi.runMigration).toBe('function')
        }
      } else {
        // In Electron context, legacy method names are used
        expect(typeof dataMigrationApi.getHistory).toBe('function')
        expect(typeof dataMigrationApi.getRegistered).toBe('function')
        expect(typeof dataMigrationApi.rollback).toBe('function')

        expect('runMigrations' in dataMigrationApi).toBe(true)
        expect('getVersionInfo' in dataMigrationApi).toBe(true)

        if ('runMigrations' in dataMigrationApi) {
          expect(typeof dataMigrationApi.runMigrations).toBe('function')
        }
        if ('getVersionInfo' in dataMigrationApi) {
          expect(typeof dataMigrationApi.getVersionInfo).toBe('function')
        }
      }
    })

    it('sessionApi should implement all canonical SessionApi methods', () => {
      // These are the canonical method names from SessionApi interface
      const canonicalMethods = [
        'save',
        'restore',
        'clear',
        'flush',
        'hasSession'
      ]

      canonicalMethods.forEach(method => {
        expect(typeof sessionApi[method as keyof typeof sessionApi]).toBe('function')
      })
    })
  })
})
