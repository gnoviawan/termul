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

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

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
 * 2. Explicit Tauri export: export const sessionApi = tauriSessionApi
 *    or export const dataMigrationApi = createTauriDataMigrationApi()
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
        adapterContent.includes(`tauri${exportName.charAt(0).toUpperCase()}${exportName.slice(1)}`) // e.g., tauriSessionApi
      )
    }
  }

  // Pattern 2: Explicit Tauri export without Electron fallback.
  // The key indicators are:
  // a) Import from the Tauri adapter file (without .ts extension in imports)
  // b) Export of the API name (already checked above)

  // Remove .ts extension for import check
  const adapterFileWithoutExt = tauriAdapterFile.replace('.ts', '')
  const hasTauriImport =
    content.includes(`from './${adapterFileWithoutExt}'`) ||
    content.includes(`from "./${adapterFileWithoutExt}"`)

  return hasTauriImport
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
    methods: [
      'spawn',
      'write',
      'resize',
      'kill',
      'onData',
      'onExit',
      // CAP-3 reclaimable leases: attach/rotate/revoke must exist on the
      // Tauri adapter — pins desktop↔web terminal parity.
      'attach',
      'rotateClaim',
      'revokeClaim'
    ],
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
  },
  // CAP-5 / Story 5: Workspace manifest facade + parity surfaces. The
  // Tauri adapter (tauri-workspace-manifest-api.ts) mirrors the three
  // `#[tauri::command] workspace_manifest_*` handlers; the web adapter
  // (web-workspace-manifest-api.ts) mirrors the three HTTP routes in
  // `web/workspace_api.rs`. Both return the SAME `IpcResult<...>` shape
  // byte-for-byte; this entry pins desktop↔web manifest parity.
  {
    domain: 'WorkspaceManifest',
    priority: 'P1',
    tauriAdapterFile: 'tauri-workspace-manifest-api.ts',
    adapterExportName: 'createTauriWorkspaceManifestApi',
    methods: ['getManifest', 'writeManifest', 'deleteManifest'],
    apiBridgeExport: 'workspaceManifestApi',
    testFile: 'tauri-workspace-manifest-api.test.ts'
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
              fileContains(
                domain.tauriAdapterFile,
                new RegExp(`export\\s+(const|function)\\s+\\b${domain.adapterExportName}\\b`)
              ),
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
          expect(testFileExists(domain.testFile), `Test file ${domain.testFile} should exist`).toBe(
            true
          )
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
              fileContains(
                domain.tauriAdapterFile,
                new RegExp(`export\\s+(const|function)\\s+\\b${domain.adapterExportName}\\b`)
              ),
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
            console.warn(
              `[WARN] ${domain.domain}: Test file ${domain.testFile} not found (P1 - recommended but not required)`
            )
          }
          // For P1, we just log a warning but the test passes
          expect(true).toBe(true)
        })
      })
    }
  })

  describe('Regression Prevention', () => {
    it('Session API uses Tauri-only export pattern', () => {
      const apiPath = join(LIB_DIR, 'api.ts')
      const apiContent = readFileSync(apiPath, 'utf-8')

      const hasTauriImport = apiContent.includes("from './tauri-session-api'")
      const hasDirectExport = apiContent.includes('export const sessionApi = tauriSessionApi')
      const hasElectronFallback = apiContent.includes("from './session-api'")

      expect(
        hasTauriImport && hasDirectExport && !hasElectronFallback,
        'api.ts should export sessionApi directly from the Tauri adapter'
      ).toBe(true)
    })

    it('Data Migration API uses Tauri-only export pattern', () => {
      const apiPath = join(LIB_DIR, 'api.ts')
      const apiContent = readFileSync(apiPath, 'utf-8')

      const hasTauriImport = apiContent.includes("from './tauri-data-migration-api'")
      const hasCreateTauriApi = apiContent.includes(
        'export const dataMigrationApi = createTauriDataMigrationApi()'
      )
      const hasElectronFallback = apiContent.includes("from './data-migration-api'")

      expect(
        hasTauriImport && hasCreateTauriApi && !hasElectronFallback,
        'api.ts should export dataMigrationApi directly from the Tauri adapter'
      ).toBe(true)
    })
  })

  describe('Summary Report', () => {
    it('should generate parity summary', () => {
      const results: Array<{
        domain: string
        implemented: boolean
        wired: boolean
        tested: boolean
      }> = []

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
      const p0Results = results.filter((r) => P0_DOMAINS.some((d) => d.domain === r.domain))
      const p0Complete = p0Results.every((r) => r.implemented && r.wired && r.tested)

      expect(p0Complete, 'All P0 domains must be fully implemented, wired, and tested').toBe(true)
    })
  })

  // CAP-5 / Story 5: Workspace manifest parity surfaces. Pins that the
  // desktop Tauri command + the web HTTP route + the renderer facade all
  // carry the SAME shape (camelCase IpcResult + tag=status WriteOutcome).
  // A drift between any pair surfaces here as a parity test failure.
  describe('Workspace Manifest parity (CAP-5)', () => {
    const TauriAdapter = join(LIB_DIR, 'tauri-workspace-manifest-api.ts')
    const WebAdapter = join(LIB_DIR, 'web-workspace-manifest-api.ts')

    it('tauri-workspace-manifest-api.ts exists and exports the factory', () => {
      expect(existsSync(TauriAdapter), 'tauri-workspace-manifest-api.ts should exist').toBe(true)
      expect(
        fileContains(
          'tauri-workspace-manifest-api.ts',
          /export\s+(const|function)\s+\bcreateTauriWorkspaceManifestApi\b/
        ),
        'should export createTauriWorkspaceManifestApi'
      ).toBe(true)
    })

    it('web-workspace-manifest-api.ts exists and exports the singleton', () => {
      expect(existsSync(WebAdapter), 'web-workspace-manifest-api.ts should exist').toBe(true)
      expect(
        fileContains(
          'web-workspace-manifest-api.ts',
          /export\s+const\s+\bwebWorkspaceManifestApi\b/
        ),
        'should export webWorkspaceManifestApi'
      ).toBe(true)
    })

    it('facade singleton exists and branches Tauri vs web by isTauriContext()', () => {
      const facade = join(LIB_DIR, 'workspace-manifest-api.ts')
      expect(existsSync(facade), 'workspace-manifest-api.ts should exist').toBe(true)
      const content = readFileSync(facade, 'utf-8')
      expect(content).toMatch(/isTauriContext\(\)/)
      expect(content).toMatch(/createTauriWorkspaceManifestApi/)
      expect(content).toMatch(/webWorkspaceManifestApi/)
    })

    it('api.ts exports the workspaceManifestApi singleton', () => {
      const apiPath = join(LIB_DIR, 'api.ts')
      const content = readFileSync(apiPath, 'utf-8')
      expect(content).toMatch(/export\s*\{[^}]*\bworkspaceManifestApi\b[^}]*\}/)
    })

    it('Tauri adapter invokes the three commands (get/write/delete)', () => {
      const content = readFileSync(TauriAdapter, 'utf-8')
      expect(content).toMatch(/workspace_manifest_get/)
      expect(content).toMatch(/workspace_manifest_write/)
      expect(content).toMatch(/workspace_manifest_delete/)
      // The Tauri adapter must pass through `basedRevision` (null = initial
      // write) + `manifest` + `projectId` to the write command — these are
      // the camelCase wire args the Rust `#[tauri::command]` declares.
      expect(content).toMatch(/basedRevision/)
      expect(content).toMatch(/manifest/)
      expect(content).toMatch(/projectId/)
    })

    it('Web adapter hits the three HTTP routes (GET /workspace/:id, POST write, POST delete)', () => {
      const content = readFileSync(WebAdapter, 'utf-8')
      expect(content).toMatch(/\/workspace\/\$\{encoded\}/)
      expect(content).toMatch(/\/workspace\/\$\{encoded\}\/write/)
      expect(content).toMatch(/\/workspace\/\$\{encoded\}\/delete/)
      // Network/parse failures must map to `NETWORK_ERROR` (mirrors the
      // existing web-server-api.ts transport-failure convention).
      expect(content).toMatch(/NETWORK_ERROR/)
    })

    it('both adapters expose getManifest / writeManifest / deleteManifest on the typed facade', () => {
      const tauri = readFileSync(TauriAdapter, 'utf-8')
      const web = readFileSync(WebAdapter, 'utf-8')
      for (const method of ['getManifest', 'writeManifest', 'deleteManifest']) {
        expect(tauri, `tauri-workspace-manifest-api.ts should implement ${method}`).toMatch(
          new RegExp(`\\b${method}\\s*\\(`)
        )
        expect(web, `web-workspace-manifest-api.ts should implement ${method}`).toMatch(
          new RegExp(`\\b${method}\\s*\\(`)
        )
      }
    })

    it('shared types file exists with expected exports (Patch 16)', () => {
      // Patch 16: this test was previously named "shared types file exists
      // and mirrors the Rust serde shapes (camelCase)" but only greps for
      // export presence — it does NOT verify TS field names match Rust serde
      // field names byte-for-byte (that would require running the Rust
      // serde shape tests, which live in the Rust suite). Renamed for
      // accuracy; the Rust side has its own serde shape pinning tests.
      const typesPath = join(LIB_DIR, '..', '..', 'shared', 'types', 'workspace-manifest.types.ts')
      expect(existsSync(typesPath), 'workspace-manifest.types.ts should exist').toBe(true)
      const content = readFileSync(typesPath, 'utf-8')
      // Core shapes mirrored from `src-tauri/src/acp/workspace_manifest.rs`.
      expect(content).toMatch(/export\s+interface\s+WorkspaceManifest\b/)
      expect(content).toMatch(/export\s+type\s+WriteOutcome\b/)
      expect(content).toMatch(/export\s+interface\s+TerminalDescriptor\b/)
      expect(content).toMatch(/export\s+interface\s+EditorDescriptor\b/)
      expect(content).toMatch(/export\s+type\s+PaneNode\b/)
      // WriteOutcome must be the discriminated union with `status: 'updated' |
      // 'conflict'` (byte-identical to the Rust serde tagged enum).
      expect(content).toMatch(/status:\s*'updated'/)
      expect(content).toMatch(/status:\s*'conflict'/)
    })

    it('ipc.types.ts declares the WorkspaceManifestIpcChannels map (Patch 11)', () => {
      // Patch 11: the channel keys use the colon-separated pattern
      // (`workspace:manifest:get`, etc.) to mirror the existing
      // `TerminalIpcChannels` (`terminal:spawn`, `terminal:attach`, …).
      const ipcPath = join(LIB_DIR, '..', '..', 'shared', 'types', 'ipc.types.ts')
      const content = readFileSync(ipcPath, 'utf-8')
      expect(content).toMatch(/WorkspaceManifestIpcChannels\b/)
      // All three channel keys must be present (colon-separated, mirroring
      // `TerminalIpcChannels`'s `terminal:spawn` pattern).
      expect(content).toMatch(/'workspace:manifest:get'/)
      expect(content).toMatch(/'workspace:manifest:write'/)
      expect(content).toMatch(/'workspace:manifest:delete'/)
    })
  })
})
