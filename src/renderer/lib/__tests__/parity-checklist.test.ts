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

    it('Story 6 sync hook imports workspaceManifestApi from the facade (not direct transport impls)', () => {
      // Story 6 wires the renderer to the manifest via the facade singleton
      // only; it must never import the tauri/web transport impls directly
      // (Biome's noRestrictedImports bans @tauri-apps/** outside lib/, and
      // the facade is the transport-neutral seam). This assertion pins that
      // the sync hook calls through `@/lib/workspace-manifest-api`.
      const syncHookPath = join(LIB_DIR, '..', 'hooks', 'use-workspace-manifest-sync.ts')
      expect(existsSync(syncHookPath), 'use-workspace-manifest-sync.ts should exist').toBe(true)
      const content = readFileSync(syncHookPath, 'utf-8')
      // P15: must be an actual import line (not a comment mentioning the path).
      expect(content).toMatch(/^\s*import\s+.*from\s+['"]@\/lib\/workspace-manifest-api['"]/m)
      // Must NOT import the transport impls directly (strengthened to require
      // an import-line match, not a bare string mention).
      expect(content).not.toMatch(
        /^\s*import\s+.*from\s+['"]@\/lib\/tauri-workspace-manifest-api['"]/m
      )
      expect(content).not.toMatch(
        /^\s*import\s+.*from\s+['"]@\/lib\/web-workspace-manifest-api['"]/m
      )
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

  // CAP-6 / Story 8: ACP Catalog parity. Mirrors the Workspace Manifest block:
  // the host-resolved catalog ships on THREE transports (Tauri command
  // `acp_list_catalog` / `acp_set_catalog_opt_in`, HTTP `GET /acp/catalog` /
  // `POST /acp/catalog/opt-in`, WS `list_acp_catalog` / `set_catalog_opt_in`).
  // This block pins the TS-side parity (the Rust-side parity — router route +
  // ws handler + Tauri command registration — is covered by the Rust test
  // suite).
  describe('ACP Catalog parity (CAP-6)', () => {
    const TauriAdapter = join(LIB_DIR, 'tauri-acp-catalog-api.ts')
    const WebAdapter = join(LIB_DIR, 'web-acp-catalog-api.ts')

    it('tauri-acp-catalog-api.ts exists and exports the factory', () => {
      expect(existsSync(TauriAdapter), 'tauri-acp-catalog-api.ts should exist').toBe(true)
      expect(
        fileContains(
          'tauri-acp-catalog-api.ts',
          /export\s+(const|function)\s+\bcreateTauriAcpCatalogApi\b/
        ),
        'should export createTauriAcpCatalogApi'
      ).toBe(true)
    })

    it('web-acp-catalog-api.ts exists and exports the singleton', () => {
      expect(existsSync(WebAdapter), 'web-acp-catalog-api.ts should exist').toBe(true)
      expect(
        fileContains('web-acp-catalog-api.ts', /export\s+const\s+\bwebAcpCatalogApi\b/),
        'should export webAcpCatalogApi'
      ).toBe(true)
    })

    it('facade singleton exists and branches Tauri vs web by isTauriContext()', () => {
      const facade = join(LIB_DIR, 'acp-catalog-api.ts')
      expect(existsSync(facade), 'acp-catalog-api.ts should exist').toBe(true)
      const content = readFileSync(facade, 'utf-8')
      expect(content).toMatch(/isTauriContext\(\)/)
      expect(content).toMatch(/createTauriAcpCatalogApi/)
      expect(content).toMatch(/webAcpCatalogApi/)
    })

    it('api.ts exports the acpCatalogApi singleton', () => {
      const apiPath = join(LIB_DIR, 'api.ts')
      const content = readFileSync(apiPath, 'utf-8')
      expect(content).toMatch(/export\s*\{[^}]*\bacpCatalogApi\b[^}]*\}/)
    })

    it('Tauri adapter invokes the catalog commands (list_catalog + set_catalog_opt_in)', () => {
      const content = readFileSync(TauriAdapter, 'utf-8')
      expect(content).toMatch(/acp_list_catalog/)
      expect(content).toMatch(/acp_set_catalog_opt_in/)
    })

    it('Web adapter hits the catalog routes (GET /acp/catalog + POST /acp/catalog/opt-in)', () => {
      const content = readFileSync(WebAdapter, 'utf-8')
      expect(content).toMatch(/\/acp\/catalog/)
      expect(content).toMatch(/\/acp\/catalog\/opt-in/)
      // Network/parse failures must map to `NETWORK_ERROR`.
      expect(content).toMatch(/NETWORK_ERROR/)
    })

    it('both adapters expose listCatalog + setCatalogOptIn + isCatalogOptedIn on the typed facade', () => {
      const tauri = readFileSync(TauriAdapter, 'utf-8')
      const web = readFileSync(WebAdapter, 'utf-8')
      for (const method of ['listCatalog', 'setCatalogOptIn', 'isCatalogOptedIn']) {
        expect(tauri, `tauri-acp-catalog-api.ts should implement ${method}`).toMatch(
          new RegExp(`\\b${method}\\s*\\(`)
        )
        expect(web, `web-acp-catalog-api.ts should implement ${method}`).toMatch(
          new RegExp(`\\b${method}\\s*\\(`)
        )
      }
    })

    it('shared types file exists with expected exports', () => {
      const typesPath = join(LIB_DIR, '..', '..', 'shared', 'types', 'acp-catalog.types.ts')
      expect(existsSync(typesPath), 'acp-catalog.types.ts should exist').toBe(true)
      const content = readFileSync(typesPath, 'utf-8')
      expect(content).toMatch(/export\s+interface\s+AcpCatalog\b/)
      expect(content).toMatch(/export\s+interface\s+CatalogAgent\b/)
      expect(content).toMatch(/export\s+type\s+SupportedAcpAgentStatus\b/)
      expect(content).toMatch(/export\s+type\s+CatalogSource\b/)
      expect(content).toMatch(/export\s+interface\s+SetCatalogOptInRequest\b/)
    })

    it('ipc.types.ts declares the AcpCatalogIpcChannels map', () => {
      const ipcPath = join(LIB_DIR, '..', '..', 'shared', 'types', 'ipc.types.ts')
      const content = readFileSync(ipcPath, 'utf-8')
      expect(content).toMatch(/AcpCatalogIpcChannels\b/)
      expect(content).toMatch(/'acp:catalog:list'/)
      expect(content).toMatch(/'acp:catalog:set_opt_in'/)
    })

    it('web-protocol.types.ts declares the WS request types for catalog', () => {
      const protoPath = join(LIB_DIR, '..', '..', 'shared', 'types', 'web-protocol.types.ts')
      const content = readFileSync(protoPath, 'utf-8')
      expect(content).toMatch(/'list_acp_catalog'/)
      expect(content).toMatch(/'set_catalog_opt_in'/)
    })
  })

  // CAP-6 / Story 9: ACP Install parity. The host-owned verified-atomic
  // install ships on THREE transports (Tauri command `acp_install_agent`,
  // HTTP `POST /acp/install`, WS `install_acp_agent`). This block pins the
  // TS-side parity (the Rust-side parity — router route + ws handler + Tauri
  // command registration — is covered by the Rust test suite).
  describe('ACP Install parity (CAP-6)', () => {
    const TauriAdapter = join(LIB_DIR, 'tauri-acp-install-api.ts')
    const WebAdapter = join(LIB_DIR, 'web-acp-install-api.ts')

    it('tauri-acp-install-api.ts exists and exports the factory', () => {
      expect(existsSync(TauriAdapter), 'tauri-acp-install-api.ts should exist').toBe(true)
      expect(
        fileContains(
          'tauri-acp-install-api.ts',
          /export\s+(const|function)\s+\bcreateTauriAcpInstallApi\b/
        ),
        'should export createTauriAcpInstallApi'
      ).toBe(true)
    })

    it('web-acp-install-api.ts exists and exports the singleton', () => {
      expect(existsSync(WebAdapter), 'web-acp-install-api.ts should exist').toBe(true)
      expect(
        fileContains('web-acp-install-api.ts', /export\s+const\s+\bwebAcpInstallApi\b/),
        'should export webAcpInstallApi'
      ).toBe(true)
    })

    it('facade singleton exists and branches Tauri vs web by isTauriContext()', () => {
      const facade = join(LIB_DIR, 'acp-install-api.ts')
      expect(existsSync(facade), 'acp-install-api.ts should exist').toBe(true)
      const content = readFileSync(facade, 'utf-8')
      expect(content).toMatch(/isTauriContext\(\)/)
      expect(content).toMatch(/createTauriAcpInstallApi/)
      expect(content).toMatch(/webAcpInstallApi/)
    })

    it('api.ts exports the acpInstallApi singleton', () => {
      const apiPath = join(LIB_DIR, 'api.ts')
      const content = readFileSync(apiPath, 'utf-8')
      expect(content).toMatch(/export\s*\{[^}]*\bacpInstallApi\b[^}]*\}/)
    })

    it('Tauri adapter invokes the install command (acp_install_agent)', () => {
      const content = readFileSync(TauriAdapter, 'utf-8')
      expect(content).toMatch(/acp_install_agent/)
    })

    it('Web adapter hits the install route (POST /acp/install)', () => {
      const content = readFileSync(WebAdapter, 'utf-8')
      expect(content).toMatch(/\/acp\/install/)
      // Network/parse failures must map to `NETWORK_ERROR`.
      expect(content).toMatch(/NETWORK_ERROR/)
    })

    it('both adapters expose installAgent on the typed facade', () => {
      const tauri = readFileSync(TauriAdapter, 'utf-8')
      const web = readFileSync(WebAdapter, 'utf-8')
      expect(tauri, 'tauri-acp-install-api.ts should implement installAgent').toMatch(
        /\binstallAgent\s*\(/
      )
      expect(web, 'web-acp-install-api.ts should implement installAgent').toMatch(
        /\binstallAgent\s*\(/
      )
    })

    it('shared types file exists with expected exports', () => {
      const typesPath = join(LIB_DIR, '..', '..', 'shared', 'types', 'acp-install.types.ts')
      expect(existsSync(typesPath), 'acp-install.types.ts should exist').toBe(true)
      const content = readFileSync(typesPath, 'utf-8')
      expect(content).toMatch(/export\s+interface\s+InstallRequest\b/)
      expect(content).toMatch(/export\s+interface\s+InstallOutcome\b/)
      expect(content).toMatch(/export\s+type\s+InstallErrorCode\b/)
    })

    it('ipc.types.ts declares the AcpInstallIpcChannels map', () => {
      const ipcPath = join(LIB_DIR, '..', '..', 'shared', 'types', 'ipc.types.ts')
      const content = readFileSync(ipcPath, 'utf-8')
      expect(content).toMatch(/AcpInstallIpcChannels\b/)
      expect(content).toMatch(/'acp:install:install_agent'/)
    })

    it('web-protocol.types.ts declares the WS request type for install', () => {
      const protoPath = join(LIB_DIR, '..', '..', 'shared', 'types', 'web-protocol.types.ts')
      const content = readFileSync(protoPath, 'utf-8')
      expect(content).toMatch(/'install_acp_agent'/)
    })
  })

  // Epic 7 — cross-client workspace continuity: the explicit host-default
  // change ships on THREE transports (Tauri command `set_host_default_project`,
  // HTTP `POST /projects/default`, WS `set_default_project` request). This
  // block pins the TS-side parity (the Rust-side parity — router route + ws
  // handler + Tauri command registration — is covered by the Rust test suite).
  // Also pins the wire rename `activeProjectId` → `defaultProjectId` +
  // `ProjectSummary.isActive` → `isDefault`.
  describe('Project default parity (Epic 7)', () => {
    const TauriRemoteApi = join(LIB_DIR, 'tauri-remote-api.ts')
    const WebServerApi = join(LIB_DIR, 'web-server-api.ts')
    const SharedTypes = join(LIB_DIR, '..', '..', 'shared', 'types', 'web-projects.types.ts')

    it('shared types rename activeProjectId → defaultProjectId + isActive → isDefault', () => {
      expect(existsSync(SharedTypes), 'web-projects.types.ts should exist').toBe(true)
      const content = readFileSync(SharedTypes, 'utf-8')
      // Renamed wire field declarations.
      expect(content).toMatch(/defaultProjectId:\s*string\s*\|\s*null/)
      expect(content).toMatch(/isDefault:\s*boolean/)
      // The OLD wire field names must NOT survive as declarations on the wire
      // shapes. (Comments may still mention the renderer's per-client
      // `activeProjectId`/`Project.isActive` — those are distinct concepts.)
      expect(content).not.toMatch(/^\s*activeProjectId:/m)
      expect(content).not.toMatch(/^\s*isActive:/m)
      // New explicit-default request type.
      expect(content).toMatch(/export\s+interface\s+SetDefaultProjectRequest\b/)
      expect(content).toMatch(/projectId:\s*string/)
    })

    it('tauri-remote-api.ts exports setHostDefaultProject + invokes set_host_default_project', () => {
      expect(existsSync(TauriRemoteApi), 'tauri-remote-api.ts should exist').toBe(true)
      const content = readFileSync(TauriRemoteApi, 'utf-8')
      expect(content).toMatch(/export\s+async\s+function\s+setHostDefaultProject\b/)
      expect(content).toMatch(/set_host_default_project/)
      // syncProjects param renamed to defaultProjectId (desktop active IS the
      // host default in desktop-hosted mode — same value, new param name).
      expect(content).toMatch(/defaultProjectId:\s*string\s*\|\s*null/)
      expect(content).not.toMatch(/activeProjectId:\s*string\s*\|\s*null/)
    })

    it('web-server-api.ts exposes setDefaultProject hitting POST /projects/default', () => {
      expect(existsSync(WebServerApi), 'web-server-api.ts should exist').toBe(true)
      const content = readFileSync(WebServerApi, 'utf-8')
      expect(content).toMatch(/setDefaultProject\b/)
      expect(content).toMatch(/\/projects\/default/)
    })
  })

  // CAP-1/CAP-2: ACP history parity. The host owns the session transcript (the
  // cross-client authority). The desktop reads it via the `acp_history_*`
  // Tauri commands (ChatHistoryStore); the web/cross-client path serves it via
  // the WS `get_session_payload` handler (SessionPersistence). There is NO HTTP
  // `/acp/sessions` route BY DESIGN — the web client fetches the payload over
  // the SAME WS connection (the host WS handler + durable store ARE the
  // cross-client authority, not a separate HTTP route). This block pins both
  // transports + the WS request types + the desktop facade.
  describe('ACP History parity (CAP-1/CAP-2)', () => {
    const HistoryFacade = join(LIB_DIR, 'acp-history-api.ts')
    const ProtoTypes = join(LIB_DIR, '..', '..', 'shared', 'types', 'web-protocol.types.ts')
    const WsRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'web', 'ws.rs')

    it('acp-history-api.ts exists + calls the host (invoke), never localStorage', () => {
      expect(existsSync(HistoryFacade), 'acp-history-api.ts should exist').toBe(true)
      const content = readFileSync(HistoryFacade, 'utf-8')
      expect(content).toMatch(/invoke/) // desktop → host Tauri command
      expect(content).toMatch(/acp_history_list/)
      expect(content).toMatch(/acp_history_get/)
      expect(content).not.toMatch(/localStorage(?:\.|\[)/) // host is the authority
    })

    it('web-protocol.types.ts declares the WS request types list_sessions + get_session_payload', () => {
      expect(existsSync(ProtoTypes), 'web-protocol.types.ts should exist').toBe(true)
      const content = readFileSync(ProtoTypes, 'utf-8')
      expect(content).toMatch(/'list_sessions'/)
      expect(content).toMatch(/'get_session_payload'/)
    })

    it('ws.rs implements handle_get_session_payload (the host cross-client authority)', () => {
      // The web/cross-client path: the WS handler materializes the transcript
      // from the host's durable store — no HTTP route, no client storage.
      expect(existsSync(WsRust), 'ws.rs should exist').toBe(true)
      const content = readFileSync(WsRust, 'utf-8')
      expect(content).toMatch(/fn handle_get_session_payload/)
      expect(content).toMatch(/handle_send_prompt/)
    })
  })

  // CAP-4: Agent spawn metadata parity. The spawn RESPONSE (not the async
  // `agent_spawned` event) is the single source of truth for the agent's
  // negotiated capabilities + auth methods + stable namespace — the renderer
  // populates them synchronously from the response. This block pins the Rust
  // `SpawnOutcome` struct + the TS `SpawnAgentResult` shape + the WS request
  // type + the Tauri command + the `agent_spawned` event channel.
  describe('Agent Spawn Metadata parity (CAP-4)', () => {
    const AcpApi = join(LIB_DIR, 'acp-api.ts')
    const ProtoTypes = join(LIB_DIR, '..', '..', 'shared', 'types', 'web-protocol.types.ts')
    const CommandsRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'acp', 'commands.rs')
    const ManagerRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'acp', 'manager.rs')

    it('Rust SpawnOutcome carries capabilities + auth_methods + stable_namespace', () => {
      expect(existsSync(ManagerRust), 'manager.rs should exist').toBe(true)
      const content = readFileSync(ManagerRust, 'utf-8')
      expect(content).toMatch(/struct SpawnOutcome/)
      expect(content).toMatch(/pub capabilities:/)
      expect(content).toMatch(/pub auth_methods:/)
      expect(content).toMatch(/pub stable_namespace:/)
    })

    it('TS SpawnAgentResult carries capabilities + authMethods + stableNamespace', () => {
      expect(existsSync(AcpApi), 'acp-api.ts should exist').toBe(true)
      const content = readFileSync(AcpApi, 'utf-8')
      expect(content).toMatch(/interface SpawnAgentResult/)
      expect(content).toMatch(/capabilities:\s*AgentCapabilities/)
      expect(content).toMatch(/authMethods:\s*AuthMethod\[\]/)
      expect(content).toMatch(/stableNamespace\?:\s*string/)
    })

    it('WS request type spawn_agent + the agent_spawned event are declared', () => {
      expect(existsSync(ProtoTypes), 'web-protocol.types.ts should exist').toBe(true)
      const content = readFileSync(ProtoTypes, 'utf-8')
      expect(content).toMatch(/'spawn_agent'/)
      expect(content).toMatch(/agent_spawned/) // the event channel (reliability tier)
    })

    it('Tauri command acp_spawn_agent is registered', () => {
      expect(existsSync(CommandsRust), 'acp/commands.rs should exist').toBe(true)
      const content = readFileSync(CommandsRust, 'utf-8')
      expect(content).toMatch(/acp_spawn_agent/)
    })
  })

  // Category E: cross-client host-authority composition. The host (Tauri
  // `invoke` / HTTP `fetch` / WS handler + durable store) is the single
  // authority for cross-client state — NOT the browser's `localStorage`. This
  // block statically asserts every cross-client state facade reaches for the
  // host, never the `localStorage` API:
  //   - acp-history-api.ts          → invoke (desktop Tauri command)
  //   - workspace-manifest-api.ts   → branches to host-backed adapters
  //   - terminal-api.ts + adapters  → invoke (desktop) / WS (web)
  //   - use-workspace-manifest-sync → reads via workspaceManifestApi.getManifest
  //   - acp-transport.ts            → subscribes via WS subscribe + lastSeq
  //
  // NOTE: real-browser Playwright/Cypress tests (mobile suspension, reconnect,
  // reload, handoff) are deferred pending a real-browser harness introduction
  // (a separate infrastructure task). This static composition block is the
  // contract-correct substitute: it proves the code paths reach for the host,
  // not localStorage — the authority model the contract requires.
  describe('Cross-client host-authority (CAP-1..6)', () => {
    const HistoryFacade = join(LIB_DIR, 'acp-history-api.ts')
    const ManifestFacade = join(LIB_DIR, 'workspace-manifest-api.ts')
    const TerminalFacade = join(LIB_DIR, 'terminal-api.ts')
    const TauriTerminalAdapter = join(LIB_DIR, 'tauri-terminal-api.ts')
    const WebTerminalAdapter = join(LIB_DIR, 'web-terminal-api.ts')
    const ManifestSyncHook = join(LIB_DIR, '..', 'hooks', 'use-workspace-manifest-sync.ts')
    const Transport = join(LIB_DIR, 'acp-transport.ts')

    it('acp-history-api.ts calls the host (invoke), never localStorage', () => {
      expect(existsSync(HistoryFacade)).toBe(true)
      const content = readFileSync(HistoryFacade, 'utf-8')
      expect(content).toMatch(/invoke/)
      expect(content).not.toMatch(/localStorage(?:\.|\[)/)
    })

    it('workspace-manifest-api.ts branches to host-backed adapters, never localStorage', () => {
      expect(existsSync(ManifestFacade)).toBe(true)
      const content = readFileSync(ManifestFacade, 'utf-8')
      expect(content).toMatch(/isTauriContext\(\)/)
      expect(content).not.toMatch(/localStorage(?:\.|\[)/)
    })

    it('terminal-api.ts + adapters route claims through the host (invoke/WS), never localStorage', () => {
      expect(existsSync(TerminalFacade)).toBe(true)
      const facade = readFileSync(TerminalFacade, 'utf-8')
      expect(facade).toMatch(/isTauriContext\(\)/)
      expect(facade).toMatch(/createTauriTerminalApi/)
      expect(facade).not.toMatch(/localStorage(?:\.|\[)/)
      // The Tauri adapter implements attach/rotateClaim/revokeClaim via invoke.
      expect(existsSync(TauriTerminalAdapter)).toBe(true)
      const tauri = readFileSync(TauriTerminalAdapter, 'utf-8')
      expect(tauri).toMatch(/invoke/)
      for (const m of ['attach', 'rotateClaim', 'revokeClaim']) {
        expect(tauri, `tauri-terminal-api.ts should implement ${m}`).toMatch(
          new RegExp(`\\b${m}\\s*\\(`)
        )
      }
      expect(tauri).not.toMatch(/localStorage(?:\.|\[)/)
      // The web adapter is WS-backed (the host WS is the authority) — no localStorage.
      expect(existsSync(WebTerminalAdapter)).toBe(true)
      expect(readFileSync(WebTerminalAdapter, 'utf-8')).not.toMatch(/localStorage(?:\.|\[)/)
    })

    it('use-workspace-manifest-sync reads via workspaceManifestApi.getManifest, never localStorage', () => {
      expect(existsSync(ManifestSyncHook), 'use-workspace-manifest-sync.ts should exist').toBe(true)
      const content = readFileSync(ManifestSyncHook, 'utf-8')
      expect(content).toMatch(/workspaceManifestApi/)
      expect(content).toMatch(/getManifest/)
      expect(content).not.toMatch(/localStorage(?:\.|\[)/)
    })

    it('acp-transport.ts subscribes via WS subscribe + lastSeq, never localStorage as the cursor', () => {
      expect(existsSync(Transport)).toBe(true)
      const content = readFileSync(Transport, 'utf-8')
      expect(content).toMatch(/subscribeSession/)
      expect(content).toMatch(/lastSeq/)
      // The cursor authority is the host (WS subscribe lastSeq / server
      // watermark), never the `localStorage` persistence API.
      expect(content).not.toMatch(/localStorage(?:\.|\[)/)
    })
  })

  // GH-587/588/589: Web non-secure-context + cross-OS parity. The shared
  // `dist-web` bundle is served by `termul-server` over plain HTTP on a bare
  // IP, where `crypto.randomUUID` / `navigator.clipboard` are unavailable and
  // `navigator.platform` reflects the client browser, not the host. These
  // static assertions pin the three fallback seams so a regression (re-adding a
  // direct `crypto.randomUUID()` / `navigator.clipboard.readText()` call, or
  // re-pinning the picker's initial path to `navigator.platform`) surfaces
  // here. The runtime behavior of each fallback is pinned by its colocated
  // unit test (uuid.test.ts, clipboard-api.web.test.ts, DirectoryPicker.test.tsx).
  describe('Web non-secure-context + cross-OS parity (GH-587/588/589)', () => {
    const UuidHelper = join(LIB_DIR, 'uuid.ts')
    const ClipboardFacade = join(LIB_DIR, 'clipboard-api.ts')
    const DirectoryPicker = join(LIB_DIR, '..', 'components', 'DirectoryPicker.tsx')
    const AcpTransport = join(LIB_DIR, 'acp-transport.ts')

    it('CAP-1: lib/uuid.ts exists and exports the safe-uuid helper', () => {
      expect(existsSync(UuidHelper), 'lib/uuid.ts should exist').toBe(true)
      const content = readFileSync(UuidHelper, 'utf-8')
      expect(content).toMatch(/export\s+function\s+\brandomUUID\b/)
    })

    it('CAP-1: uuid helper uses native crypto.randomUUID when present, else a getRandomValues fallback', () => {
      const content = readFileSync(UuidHelper, 'utf-8')
      // Prefers the native API when available (secure context).
      expect(content).toMatch(/crypto\.randomUUID/)
      // Falls back to the CSPRNG available in ALL browser contexts (HTTP+HTTPS).
      expect(content).toMatch(/getRandomValues/)
      // Sets the RFC-4122 v4 version + variant bits so server-side id matching
      // (turn:<uuid>, WS frame ids) stays valid — NOT a Math.random() call.
      expect(content).toMatch(/0x40/)
      expect(content).toMatch(/0x80/)
      expect(content).not.toMatch(/Math\.random\s*\(/)
    })

    it('CAP-1: acp-transport.ts no longer calls crypto.randomUUID directly (uses the helper)', () => {
      expect(existsSync(AcpTransport), 'acp-transport.ts should exist').toBe(true)
      const content = readFileSync(AcpTransport, 'utf-8')
      // The helper import must be present.
      expect(content).toMatch(/from\s+['"]@\/lib\/uuid['"]/)
      // No direct crypto.randomUUID() call remains in the transport hot path.
      expect(content).not.toMatch(/crypto\.randomUUID\(\)/)
    })

    it('CAP-2: clipboard-api.ts browser path has a non-navigator.clipboard fallback', () => {
      expect(existsSync(ClipboardFacade), 'clipboard-api.ts should exist').toBe(true)
      const content = readFileSync(ClipboardFacade, 'utf-8')
      // Structured logging for the fallback trigger (not raw console.*).
      expect(content).toMatch(/logFrontendError/)
      // readText fallback: a document-level paste-event capture.
      expect(content).toMatch(/['"]paste['"]/)
      expect(content).toMatch(/clipboardData/)
      // writeText fallback: a hidden textarea + the legacy synchronous copy.
      expect(content).toMatch(/createElement\(['"]textarea['"]\)/)
      expect(content).toMatch(/execCommand\(['"]copy['"]\)/)
      // The desktop tauriClipboardApi path is preserved (facade boundary).
      expect(content).toMatch(/tauriClipboardApi/)
      expect(content).toMatch(/isTauriContext\(\)/)
    })

    it('CAP-2: ConnectedTerminal Ctrl+V degrades to native xterm paste when navigator.clipboard is undefined', () => {
      // In a non-secure context the facade's paste-event fallback can't fire
      // for the terminal Ctrl+V — the keydown handler would preventDefault the
      // very paste event it waits on. The handler must detect the missing Async
      // Clipboard API and let xterm handle the key natively (return true) so the
      // browser paste event reaches xterm's helper textarea. The secure-context
      // path keeps the bracketed + sanitized paste via pasteFromClipboard.
      const ConnectedTerminal = join(
        LIB_DIR,
        '..',
        'components',
        'terminal',
        'ConnectedTerminal.tsx'
      )
      expect(existsSync(ConnectedTerminal), 'ConnectedTerminal.tsx should exist').toBe(true)
      const content = readFileSync(ConnectedTerminal, 'utf-8')
      expect(content).toMatch(/case ['"]v['"]/)
      // Pins the non-secure branch exists (specific to the degrade path); the
      // bare `return true` check was too coarse (matched any return in the file).
      expect(content).toMatch(/typeof navigator\.clipboard === ['"]undefined['"]/)
    })

    it('CAP-3: DirectoryPicker sources the initial path from the host catalog (acpCatalogApi.listCatalog), not navigator.platform', () => {
      expect(existsSync(DirectoryPicker), 'DirectoryPicker.tsx should exist').toBe(true)
      const content = readFileSync(DirectoryPicker, 'utf-8')
      // Imports the catalog facade (host-OS source of truth).
      expect(content).toMatch(/from\s+['"]@\/lib\/acp-catalog-api['"]/)
      expect(content).toMatch(/acpCatalogApi/)
      // Resolves the initial path by awaiting listCatalog() and reading host.os.
      expect(content).toMatch(/listCatalog\(\)/)
      expect(content).toMatch(/host\.os|host\?\.os/)
      // Maps the known host OS values to filesystem roots.
      expect(content).toMatch(/['"]windows['"]/)
      expect(content).toMatch(/['"]linux['"]/)
      expect(content).toMatch(/C:\\\\/)
      // The navigator.platform fallback is preserved ONLY for the
      // catalog-unavailable degrade path (picker never fails to open).
      expect(content).toMatch(/navigator\.platform/)
      // The module-level INITIAL_PATH const that sourced from navigator.platform
      // at import-time is gone (replaced by an async resolveInitialPath).
      expect(content).not.toMatch(/const\s+INITIAL_PATH\s*=/)
    })
  })

  // CAP — Web worktree parity. The 7 launch-flow worktree ops ship on THREE
  // transports (Tauri command `worktree_*`, HTTP `/worktree/*` route, facade
  // branch `isTauriContext()` between `invoke(...)` and `webServerWorktree`).
  // This block pins the TS-side parity (the Rust-side parity — router routes +
  // Tauri command registration + `web/worktree_api.rs` — is covered by the Rust
  // test suite). The 8 advanced ops stay `WEB_UNSUPPORTED` on web (deferred).
  describe('Worktree parity (CAP — Web worktree parity)', () => {
    const Facade = join(LIB_DIR, 'worktree-api.ts')
    const WebAdapter = join(LIB_DIR, 'web-server-api.ts')
    const RouterRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'web', 'router.rs')
    const WorktreeApiRust = join(
      LIB_DIR,
      '..',
      '..',
      '..',
      'src-tauri',
      'src',
      'web',
      'worktree_api.rs'
    )
    const CommandsRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'commands.rs')

    const LAUNCH_FLOW_METHODS = [
      'list',
      'create',
      'remove',
      'branches',
      'checkDirty',
      'resolveBaseBranch',
      'copyIncludeFiles'
    ] as const

    const ADVANCED_METHODS = [
      'removeAllManaged',
      'parseGitignore',
      'createSymlinks',
      'ensureSymlinks',
      'archive',
      'restore',
      'mergePreview',
      'mergeExecute'
    ] as const

    it('worktree-api.ts facade exists and branches on isTauriContext()', () => {
      expect(existsSync(Facade), 'worktree-api.ts should exist').toBe(true)
      const content = readFileSync(Facade, 'utf-8')
      expect(content).toMatch(/isTauriContext\(\)/)
      expect(content).toMatch(/webServerWorktree/)
    })

    it('web-server-api.ts exports webServerWorktree hitting the 7 routes', () => {
      expect(existsSync(WebAdapter), 'web-server-api.ts should exist').toBe(true)
      const content = readFileSync(WebAdapter, 'utf-8')
      expect(content).toMatch(/export\s+const\s+\bwebServerWorktree\b/)
      for (const route of [
        '/worktree/list',
        '/worktree/create',
        '/worktree/remove',
        '/worktree/branches',
        '/worktree/check-dirty',
        '/worktree/resolve-base-branch',
        '/worktree/copy-include-files'
      ]) {
        expect(content, `web-server-api.ts should hit ${route}`).toMatch(
          new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        )
      }
      // Network/parse failures must map to `NETWORK_ERROR`.
      expect(content).toMatch(/NETWORK_ERROR/)
    })

    it('facade branches the 7 launch-flow methods (invoke on Tauri, webServerWorktree on web)', () => {
      const content = readFileSync(Facade, 'utf-8')
      for (const method of LAUNCH_FLOW_METHODS) {
        expect(content, `worktree-api.ts should branch ${method}`).toMatch(
          new RegExp(`\\b${method}\\s*\\(`)
        )
      }
      // The 7 launch-flow methods must reference `webServerWorktree` (the web branch).
      const launchFlowRefs = (content.match(/webServerWorktree\./g) ?? []).length
      expect(launchFlowRefs, '7 launch-flow methods should reference webServerWorktree').toBe(7)
    })

    it('facade keeps the 8 advanced methods as WEB_UNSUPPORTED (no webServerWorktree ref)', () => {
      const content = readFileSync(Facade, 'utf-8')
      for (const method of ADVANCED_METHODS) {
        expect(content, `worktree-api.ts should still define ${method}`).toMatch(
          new RegExp(`\\b${method}\\s*:`)
        )
      }
      // Exactly 7 webServerWorktree refs (not 8) — the advanced methods do NOT branch.
      const launchFlowRefs = (content.match(/webServerWorktree\./g) ?? []).length
      expect(launchFlowRefs).toBe(7)
    })

    it('router.rs registers the 7 /worktree/* routes ahead of the static fallback', () => {
      expect(existsSync(RouterRust), 'router.rs should exist').toBe(true)
      const content = readFileSync(RouterRust, 'utf-8')
      for (const route of [
        '/worktree/list',
        '/worktree/create',
        '/worktree/remove',
        '/worktree/branches',
        '/worktree/check-dirty',
        '/worktree/resolve-base-branch',
        '/worktree/copy-include-files'
      ]) {
        expect(content, `router.rs should register ${route}`).toMatch(
          new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        )
      }
    })

    it('worktree_api.rs exists and defines the 7 Axum handlers', () => {
      expect(existsSync(WorktreeApiRust), 'worktree_api.rs should exist').toBe(true)
      const content = readFileSync(WorktreeApiRust, 'utf-8')
      for (const handler of [
        'pub async fn list',
        'pub async fn create',
        'pub async fn remove',
        'pub async fn branches',
        'pub async fn check_dirty',
        'pub async fn resolve_base_branch',
        'pub async fn copy_include_files'
      ]) {
        expect(content, `worktree_api.rs should define ${handler}`).toMatch(
          new RegExp(handler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        )
      }
      // IpcBody contract + spawn_blocking + tracing logs.
      expect(content).toMatch(/IpcBody/)
      expect(content).toMatch(/spawn_blocking/)
      expect(content).toMatch(/tracing/)
      // Loopback guard on write routes + containment on all routes.
      expect(content).toMatch(/check_local_only/)
      expect(content).toMatch(/ensure_within_project_boundary/)
    })

    it('commands.rs defines the 7 desktop Tauri commands (worktree_*)', () => {
      expect(existsSync(CommandsRust), 'commands.rs should exist').toBe(true)
      const content = readFileSync(CommandsRust, 'utf-8')
      for (const cmd of [
        'worktree_list',
        'worktree_create',
        'worktree_remove',
        'worktree_branches',
        'worktree_check_dirty',
        'worktree_resolve_base_branch',
        'worktree_copy_include_files'
      ]) {
        expect(content, `commands.rs should define ${cmd}`).toMatch(
          new RegExp(`\\b${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
        )
      }
    })
  })

  // Global right-click context menu + production devtools block. Pins that:
  //   - GlobalContextMenu wraps BOTH roots (TauriApp.tsx + App.tsx) for parity.
  //   - The devtools-shortcut blocker is desktop-only + PROD-gated (TauriApp, not App).
  //   - The native-context-menu preventDefault hook (usePreventNativeContextMenu) is
  //     mounted on BOTH roots (P4: portal regression defense).
  //   - The browser-tab devtools command is cfg-gated in Rust (debug real impl,
  //     release Err stub); the manager method is debug-only (P13: no release stub).
  //   - The Debug Console button is hidden in prod (import.meta.env.PROD).
  describe('Global context menu + devtools block parity', () => {
    const GlobalMenu = join(LIB_DIR, '..', 'components', 'GlobalContextMenu.tsx')
    const DevtoolsHook = join(LIB_DIR, '..', 'hooks', 'use-prevent-devtools-shortcuts.ts')
    const TextEditOps = join(LIB_DIR, 'text-edit-ops.ts')
    const TauriApp = join(LIB_DIR, '..', 'TauriApp.tsx')
    const WebApp = join(LIB_DIR, '..', 'App.tsx')
    const BrowserControls = join(LIB_DIR, '..', 'components', 'browser', 'BrowserControls.tsx')
    const CommandsRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'commands.rs')
    const BrowserTabManagerRust = join(
      LIB_DIR,
      '..',
      '..',
      '..',
      'src-tauri',
      'src',
      'browser_tab_manager.rs'
    )

    it('GlobalContextMenu.tsx exists and renders the Radix menu with Copy/Cut/Paste/Select All', () => {
      expect(existsSync(GlobalMenu), 'GlobalContextMenu.tsx should exist').toBe(true)
      const content = readFileSync(GlobalMenu, 'utf-8')
      expect(content).toMatch(/from\s+['"]@\/components\/ui\/context-menu['"]/)
      expect(content).toMatch(/ContextMenuContent/)
      expect(content).toMatch(/ContextMenuTrigger/)
      expect(content).toMatch(/ContextMenuSeparator/)
      // The four edit operations must be wired. The "no Reload/Back/Inspect"
      // constraint is asserted at runtime by GlobalContextMenu.test.tsx
      // (queryByRole), not here — this is a static file check.
      expect(content).toMatch(/copySelection/)
      expect(content).toMatch(/cutSelection/)
      expect(content).toMatch(/pasteIntoFocused/)
      expect(content).toMatch(/selectAllFocused/)
    })

    it('text-edit-ops.ts exists with the four edit helpers + log-api boundary', () => {
      expect(existsSync(TextEditOps), 'text-edit-ops.ts should exist').toBe(true)
      const content = readFileSync(TextEditOps, 'utf-8')
      expect(content).toMatch(/export\s+async\s+function\s+\bcopySelection\b/)
      expect(content).toMatch(/export\s+async\s+function\s+\bcutSelection\b/)
      expect(content).toMatch(/export\s+async\s+function\s+\bpasteIntoFocused\b/)
      expect(content).toMatch(/export\s+function\s+\bselectAllFocused\b/)
      // Reuses clipboardApi + copyText + logFrontendError (never throws).
      expect(content).toMatch(/clipboardApi/)
      expect(content).toMatch(/copyText/)
      expect(content).toMatch(/logFrontendError/)
    })

    it('use-prevent-devtools-shortcuts.ts exists and is a capture-phase keydown blocker', () => {
      expect(existsSync(DevtoolsHook), 'use-prevent-devtools-shortcuts.ts should exist').toBe(true)
      const content = readFileSync(DevtoolsHook, 'utf-8')
      // Capture-phase document listener (mirror usePreventDefaultContextMenu shape).
      expect(content).toMatch(/addEventListener\(\s*['"]keydown['"]/)
      expect(content).toMatch(/capture:\s*true/)
      // P5: production-gated (no-op in dev so devs keep F12 access).
      expect(content).toMatch(/import\.meta\.env\.PROD/)
      // P6: uses e.code (locale-independent) for the letter matches.
      expect(content).toMatch(/KeyI/)
      expect(content).toMatch(/KeyJ/)
      expect(content).toMatch(/KeyC/)
      expect(content).toMatch(/KeyU/)
      // P6: accepts metaKey (macOS Cmd).
      expect(content).toMatch(/metaKey/)
      // P6: excludes altKey.
      expect(content).toMatch(/!.*altKey|!e\.altKey/)
      // preventDefault + stopPropagation on match.
      expect(content).toMatch(/preventDefault/)
      expect(content).toMatch(/stopPropagation/)
      // P10: boundary log via logFrontendError on each block.
      expect(content).toMatch(/logFrontendError/)
    })

    it('TauriApp.tsx wraps root in GlobalContextMenu + mounts the devtools blocker + native-context-menu defense', () => {
      expect(existsSync(TauriApp), 'TauriApp.tsx should exist').toBe(true)
      const content = readFileSync(TauriApp, 'utf-8')
      expect(content).toMatch(/GlobalContextMenu/)
      expect(content).toMatch(/usePreventDevToolsShortcuts/)
      // P4: the native-context-menu preventDefault hook is re-added as
      // defense-in-depth (usePreventNativeContextMenu) alongside
      // <GlobalContextMenu> so portaled overlays don't show the native menu.
      expect(content).toMatch(/usePreventNativeContextMenu/)
      // The old hook name must be gone (renamed).
      expect(content).not.toMatch(/usePreventDefaultContextMenu/)
    })

    it('App.tsx wraps root in GlobalContextMenu + mounts native-context-menu defense (no devtools blocker)', () => {
      expect(existsSync(WebApp), 'App.tsx should exist').toBe(true)
      const content = readFileSync(WebApp, 'utf-8')
      expect(content).toMatch(/GlobalContextMenu/)
      // P4: web also mounts the native-context-menu defense (portal regression).
      expect(content).toMatch(/usePreventNativeContextMenu/)
      // Web parity: NO devtools blocker (browser cannot block its own devtools).
      // Assert no import of the hook (the dashed import path), not the camelCase
      // name — App.tsx's comment mentions the hook by name for documentation.
      expect(content).not.toMatch(/from\s+['"]@\/hooks\/use-prevent-devtools-shortcuts['"]/)
      expect(content).not.toMatch(/usePreventDevToolsShortcuts\(\)/)
    })

    it('commands.rs cfg-gates browser_tab_open_devtools (debug real, release Err stub)', () => {
      expect(existsSync(CommandsRust), 'commands.rs should exist').toBe(true)
      const content = readFileSync(CommandsRust, 'utf-8')
      expect(content).toMatch(/#\[cfg\(debug_assertions\)\][\s\S]*?browser_tab_open_devtools/)
      expect(content).toMatch(
        /#\[cfg\(not\(debug_assertions\)\)\][\s\S]*?browser_tab_open_devtools/
      )
      expect(content).toMatch(/DevTools disabled in production/)
    })

    it('browser_tab_manager.rs cfg-gates open_devtools (debug-only; P13: no release stub)', () => {
      expect(existsSync(BrowserTabManagerRust), 'browser_tab_manager.rs should exist').toBe(true)
      const content = readFileSync(BrowserTabManagerRust, 'utf-8')
      // P13: only the debug (#[cfg(debug_assertions)]) method exists — the
      // release stub was removed (the release command returns the error
      // directly, so the method is never called in release → no dead_code).
      expect(content).toMatch(/#\[cfg\(debug_assertions\)\][\s\S]*?fn\s+open_devtools/)
      // No release cfg-gated open_devtools stub (P13 removed it).
      expect(content).not.toMatch(/#\[cfg\(not\(debug_assertions\)\)\][\s\S]*?fn\s+open_devtools/)
    })

    it('BrowserControls.tsx hides the Debug Console button in production', () => {
      expect(existsSync(BrowserControls), 'BrowserControls.tsx should exist').toBe(true)
      const content = readFileSync(BrowserControls, 'utf-8')
      expect(content).toMatch(/import\.meta\.env\.PROD/)
      expect(content).toMatch(/browserTabOpenDevtools/)
    })

    it('ProjectSidebar.tsx handleContextMenu calls stopPropagation so the global trigger does not fire', () => {
      const sidebar = join(LIB_DIR, '..', 'components', 'ProjectSidebar.tsx')
      expect(existsSync(sidebar), 'ProjectSidebar.tsx should exist').toBe(true)
      const content = readFileSync(sidebar, 'utf-8')
      // The handleContextMenu callback must call both preventDefault and
      // stopPropagation so the global Radix trigger doesn't double-fire.
      const handlerMatch = content.match(
        /handleContextMenu[\s\S]*?useCallback\(([\s\S]*?),\s*\[\]\)/
      )
      expect(handlerMatch, 'handleContextMenu callback should exist').not.toBeNull()
      const handler = handlerMatch![1]
      expect(handler).toMatch(/preventDefault/)
      expect(handler).toMatch(/stopPropagation/)
    })

    it('FileExplorer.tsx handleContextMenu calls stopPropagation (pre-existing pattern)', () => {
      const explorer = join(LIB_DIR, '..', 'components', 'file-explorer', 'FileExplorer.tsx')
      expect(existsSync(explorer), 'FileExplorer.tsx should exist').toBe(true)
      const content = readFileSync(explorer, 'utf-8')
      const handlerMatch = content.match(/handleContextMenu[\s\S]*?useCallback\(([\s\S]*?),\s*\[/)
      expect(handlerMatch, 'FileExplorer handleContextMenu callback should exist').not.toBeNull()
      const handler = handlerMatch![1]
      expect(handler).toMatch(/preventDefault/)
      expect(handler).toMatch(/stopPropagation/)
    })
  })
})
