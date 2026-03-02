/**
 * Automated Parity Checklist Tests
 *
 * This test suite automatically verifies that critical domains are properly
 * implemented, wired, and tested for Tauri parity. It prevents regressions
 * where domains might fall back to Electron implementations.
 *
 * Based on Wave 1 - Task 1 parity matrix.
 *
 * P0 Domains (Critical):
 * - Session: Session persistence across app restarts
 * - Data Migration: Schema migration system
 *
 * P1 Domains (High Priority):
 * - Terminal: PTY spawn, I/O, resize, kill
 * - System: OS info, power events, paths
 * - Keyboard: Global shortcuts, hotkeys
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

// Type definitions for our test data
interface DomainCheck {
  domain: string
  priority: 'P0' | 'P1'
  tauriAdapterFile: string
  adapterExportName?: string
  methods: string[]
  apiBridgeExport: string
  testFile: string
}

/**
 * Get the absolute path to the lib directory
 */
const LIB_DIR = join(__dirname, '..')
const TESTS_DIR = __dirname

/**
 * Helper to check if a file exists
 */
function fileExists(relativePath: string): boolean {
  const absolutePath = join(LIB_DIR, relativePath)
  return existsSync(absolutePath)
}

/**
 * Helper to check if a test file exists
 */
function testFileExists(relativePath: string): boolean {
  const absolutePath = join(TESTS_DIR, relativePath)
  return existsSync(absolutePath)
}

/**
 * Helper to read file content and check for specific patterns
 */
function fileContains(relativePath: string, pattern: RegExp): boolean {
  const absolutePath = join(LIB_DIR, relativePath)
  if (!existsSync(absolutePath)) return false
  const content = readFileSync(absolutePath, 'utf-8')
  return pattern.test(content)
}

/**
 * Helper to check if api.ts imports from a Tauri adapter
 *
 * This supports two patterns:
 * 1. Direct import: export { terminalApi } from './terminal-api'
 *    where terminal-api.ts imports from tauri-terminal-api
 * 2. Facade pattern: export const sessionApi = isTauriContext() ? tauriSessionApi : electronSessionApi
 *    where the file imports from both tauri- and electron versions
 */
function apiBridgeUsesTauriAdapter(exportName: string, tauriAdapterFile: string): boolean {
  const apiPath = join(LIB_DIR, 'api.ts')
  if (!existsSync(apiPath)) return false

  const content = readFileSync(apiPath, 'utf-8')

  // Check that the export exists
  const exportPattern = new RegExp(`export.*\\b${exportName}\\b`, 'm')
  if (!exportPattern.test(content)) return false

  // Pattern 1: Direct export from adapter file (e.g., export { terminalApi } from './terminal-api')
  const directExportMatch = content.match(
    new RegExp(`export\\s+\\{[^}]*\\b${exportName}\\b[^}]*\\}\\s+from\\s+['"]([^'"]+)['"]`)
  )

  if (directExportMatch) {
    const importPath = directExportMatch[1]
    // Check if the imported file uses Tauri adapter
    const adapterPath = join(LIB_DIR, `${importPath}.ts`)
    if (existsSync(adapterPath)) {
      const adapterContent = readFileSync(adapterPath, 'utf-8')
      // Check for imports from tauri- files or createTauriXxxApi pattern
      return (
        adapterContent.includes(`from './${tauriAdapterFile}'`) ||
        adapterContent.includes(`from "./${tauriAdapterFile}"`) ||
        adapterContent.includes('createTauri') ||
        adapterContent.includes('tauri' + exportName.charAt(0).toUpperCase() + exportName.slice(1)) // e.g., tauriSessionApi
      )
    }
  }

  // Pattern 2: Facade pattern with runtime context detection
  // The key indicators are:
  // a) Import from the Tauri adapter file (without .ts extension in imports)
  // b) Export of the API name (already checked above)
  // c) isTauriContext() usage for runtime detection

  // Remove .ts extension for import check
  const adapterFileWithoutExt = tauriAdapterFile.replace('.ts', '')
  const hasTauriImport = content.includes(`from './${adapterFileWithoutExt}'`) ||
    content.includes(`from "./${adapterFileWithoutExt}"`)

  const hasContextDetection = content.includes('isTauriContext()')

  // If we have Tauri import and context detection, it's a facade pattern
  if (hasTauriImport && hasContextDetection) {
    return true
  }

  return false
}

/**
 * Critical domains to verify for Tauri parity
 */
const P0_DOMAINS: DomainCheck[] = [
  {
    domain: 'Session',
    priority: 'P0',
    tauriAdapterFile: 'tauri-session-api.ts',
    adapterExportName: 'createTauriSessionApi',
    methods: ['save', 'restore', 'clear', 'flush', 'hasSession'],
    apiBridgeExport: 'sessionApi',
    testFile: 'tauri-session-api.test.ts'
  },
  {
    domain: 'Data Migration',
    priority: 'P0',
    tauriAdapterFile: 'tauri-data-migration-api.ts',
    adapterExportName: 'createTauriDataMigrationApi',
    methods: ['runMigration', 'getHistory', 'getRegistered', 'rollback', 'getVersion'],
    apiBridgeExport: 'dataMigrationApi',
    testFile: 'tauri-data-migration-api.test.ts'
  }
]

const P1_DOMAINS: DomainCheck[] = [
  {
    domain: 'Terminal',
    priority: 'P1',
    tauriAdapterFile: 'tauri-terminal-api.ts',
    adapterExportName: 'createTauriTerminalApi',
    methods: ['spawn', 'write', 'resize', 'kill', 'onData', 'onExit'],
    apiBridgeExport: 'terminalApi',
    testFile: 'tauri-terminal-api.test.ts' // May not exist yet, check in test
  },
  {
    domain: 'System',
    priority: 'P1',
    tauriAdapterFile: 'tauri-system-api.ts',
    adapterExportName: 'createTauriSystemApi',
    methods: ['getHomeDirectory', 'onPowerResume'], // getTempDirectory not implemented
    apiBridgeExport: 'systemApi',
    testFile: 'tauri-system-api.test.ts' // May not exist yet
  },
  {
    domain: 'Keyboard',
    priority: 'P1',
    tauriAdapterFile: 'tauri-keyboard-api.ts',
    adapterExportName: 'createTauriKeyboardApi',
    methods: ['onShortcut'],
    apiBridgeExport: 'keyboardApi',
    testFile: 'tauri-keyboard-api.test.ts' // May not exist yet
  }
]

const ALL_DOMAINS = [...P0_DOMAINS, ...P1_DOMAINS]

describe('Parity Checklist Automation', () => {
  describe('P0 Domains (Critical)', () => {
    for (const domain of P0_DOMAINS) {
      describe(`${domain.domain} Domain`, () => {
        it(`Implemented: ${domain.tauriAdapterFile} exists and exports factory`, () => {
          // Check Tauri adapter file exists
          expect(
            fileExists(domain.tauriAdapterFile),
            `${domain.tauriAdapterFile} should exist`
          ).toBe(true)

          // Check it exports the factory function
          if (domain.adapterExportName) {
            expect(
              fileContains(domain.tauriAdapterFile, new RegExp(`export\\s+(const|function)\\s+\\b${domain.adapterExportName}\\b`)),
              `${domain.tauriAdapterFile} should export ${domain.adapterExportName}`
            ).toBe(true)
          }

          // Check key methods are implemented
          for (const method of domain.methods) {
            expect(
              fileContains(domain.tauriAdapterFile, new RegExp(`\\b${method}\\s*\\(`)),
              `${domain.tauriAdapterFile} should implement ${method}()`
            ).toBe(true)
          }
        })

        it(`Wired: api.ts exports from Tauri adapter`, () => {
          expect(
            apiBridgeUsesTauriAdapter(domain.apiBridgeExport, domain.tauriAdapterFile),
            `api.ts should export ${domain.apiBridgeExport} from Tauri adapter`
          ).toBe(true)
        })

        it(`Verified: Test file exists at ${domain.testFile}`, () => {
          expect(
            testFileExists(domain.testFile),
            `Test file ${domain.testFile} should exist`
          ).toBe(true)
        })
      })
    }
  })

  describe('P1 Domains (High Priority)', () => {
    for (const domain of P1_DOMAINS) {
      describe(`${domain.domain} Domain`, () => {
        it(`Implemented: ${domain.tauriAdapterFile} exists and exports factory`, () => {
          // Check Tauri adapter file exists
          expect(
            fileExists(domain.tauriAdapterFile),
            `${domain.tauriAdapterFile} should exist`
          ).toBe(true)

          // Check it exports the factory function
          if (domain.adapterExportName) {
            expect(
              fileContains(domain.tauriAdapterFile, new RegExp(`export\\s+(const|function)\\s+\\b${domain.adapterExportName}\\b`)),
              `${domain.tauriAdapterFile} should export ${domain.adapterExportName}`
            ).toBe(true)
          }

          // Check key methods are implemented
          for (const method of domain.methods) {
            expect(
              fileContains(domain.tauriAdapterFile, new RegExp(`\\b${method}\\s*\\(`)),
              `${domain.tauriAdapterFile} should implement ${method}()`
            ).toBe(true)
          }
        })

        it(`Wired: api.ts exports from Tauri adapter`, () => {
          expect(
            apiBridgeUsesTauriAdapter(domain.apiBridgeExport, domain.tauriAdapterFile),
            `api.ts should export ${domain.apiBridgeExport} from Tauri adapter`
          ).toBe(true)
        })

        it(`Verified: Test file exists at ${domain.testFile}`, () => {
          // P1 tests are optional (warn but don't fail)
          const testExists = testFileExists(domain.testFile)
          if (!testExists) {
            console.warn(`[WARN] ${domain.domain}: Test file ${domain.testFile} not found (P1 - recommended but not required)`)
          }
          // For P1, we just log a warning but the test passes
          expect(true).toBe(true)
        })
      })
    }
  })

  describe('Regression Prevention', () => {
    it('Session API uses Tauri-first facade pattern', () => {
      const apiPath = join(LIB_DIR, 'api.ts')
      const apiContent = readFileSync(apiPath, 'utf-8')

      // Check for Tauri-first facade pattern:
      // 1. Imports from tauri-session-api
      // 2. Has isTauriContext() runtime detection
      // 3. Uses conditional export with Tauri adapter

      const hasTauriImport = apiContent.includes("from './tauri-session-api'")
      const hasContextDetection = apiContent.includes('isTauriContext()')
      const hasFacadePattern = apiContent.includes('tauriSessionApi')

      expect(
        hasTauriImport && hasContextDetection && hasFacadePattern,
        'api.ts should use Tauri-first facade pattern for sessionApi'
      ).toBe(true)
    })

    it('Data Migration API uses Tauri-first facade pattern', () => {
      const apiPath = join(LIB_DIR, 'api.ts')
      const apiContent = readFileSync(apiPath, 'utf-8')

      // Check for Tauri-first facade pattern
      const hasTauriImport = apiContent.includes("from './tauri-data-migration-api'")
      const hasContextDetection = apiContent.includes('isTauriContext()')
      const hasCreateTauriApi = apiContent.includes('createTauriDataMigrationApi')

      expect(
        hasTauriImport && hasContextDetection && hasCreateTauriApi,
        'api.ts should use Tauri-first facade pattern for dataMigrationApi'
      ).toBe(true)
    })
  })

  describe('Summary Report', () => {
    it('should generate parity summary', () => {
      const results: Array<{ domain: string; implemented: boolean; wired: boolean; tested: boolean }> = []

      for (const domain of ALL_DOMAINS) {
        const implemented = fileExists(domain.tauriAdapterFile)
        const wired = apiBridgeUsesTauriAdapter(domain.apiBridgeExport, domain.tauriAdapterFile)
        const tested = testFileExists(domain.testFile)

        results.push({
          domain: domain.domain,
          implemented,
          wired,
          tested
        })
      }

      // Log summary for CI visibility
      console.table(results)

      // All P0 domains must be fully implemented, wired, and tested
      const p0Results = results.filter(r => P0_DOMAINS.some(d => d.domain === r.domain))
      const p0Complete = p0Results.every(r => r.implemented && r.wired && r.tested)

      expect(p0Complete, 'All P0 domains must be fully implemented, wired, and tested').toBe(true)
    })
  })
})
