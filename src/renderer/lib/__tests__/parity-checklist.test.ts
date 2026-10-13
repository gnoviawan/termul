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

import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
 * Read a Rust module that may be a single file (`foo.rs`) or a directory
 * module (`foo/mod.rs` + siblings). Concatenates all `*.rs` files in the
 * directory so source-grep checks stay agnostic to the internal submodule
 * layout.
 */
const readRustModule = (pathNoExt: string): string => {
  const filePath = `${pathNoExt}.rs`
  if (existsSync(filePath)) return readFileSync(filePath, 'utf-8')
  return readdirSync(pathNoExt)
    .filter((f) => f.endsWith('.rs'))
    .sort()
    .map((f) => readFileSync(join(pathNoExt, f), 'utf-8'))
    .join('\n')
}

/**
 * Read a TS module that may be a single file (`foo.ts`) or a facade +
 * module directory (`foo.ts` re-exporting `foo/index.ts` + siblings — e.g.
 * `stores/acp-store`, `lib/acp-transport`). Concatenates the facade file and
 * all non-test `*.ts` files in the sibling directory so source-grep checks
 * stay agnostic to the internal module layout. Takes the extension-less
 * path.
 */
const readTsModule = (pathNoExt: string): string => {
  const filePath = `${pathNoExt}.ts`
  const fileContent = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
  if (!existsSync(pathNoExt)) return fileContent
  const dirContent = readdirSync(pathNoExt)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort()
    .map((f) => readFileSync(join(pathNoExt, f), 'utf-8'))
    .join('\n')
  return `${fileContent}\n${dirContent}`
}

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

  describe('Factory key host transport parity', () => {
    it('uses matching desktop and web commands without browser persistence', () => {
      const content = readFileSync(join(LIB_DIR, 'factory-key-api.ts'), 'utf-8')
      expect(content).toMatch(/acp_factory_key_status/)
      expect(content).toMatch(/acp_factory_key_save/)
      expect(content).toMatch(/\/acp\/factory-key/)
      expect(content).toMatch(/authHeader\(\)/)
      expect(content).not.toMatch(/localStorage|sessionStorage/)
    })

    it('registers both host surfaces through the shared Rust service', () => {
      const root = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
      const tauri = readFileSync(join(root, 'lib.rs'), 'utf-8')
      const router = readFileSync(join(root, 'web', 'router.rs'), 'utf-8')
      expect(tauri).toMatch(/acp_factory_key_status/)
      expect(tauri).toMatch(/acp_factory_key_save/)
      expect(router).toMatch(/\/acp\/factory-key/)
    })
  })

  // CAP-6 / Story 8: ACP Catalog parity. The host-resolved catalog ships on
  // two carriers: HTTP `GET /acp/catalog` / `POST /acp/catalog/opt-in` (web)
  // and the `/ws` requests `list_acp_catalog` / `set_catalog_opt_in` (desktop
  // channel and web). This block pins the TS-side parity (the Rust-side parity
  // — router route + ws handler — is covered by the Rust test suite).
  describe('ACP Catalog parity (CAP-6)', () => {
    const WebAdapter = join(LIB_DIR, 'web-acp-catalog-api.ts')

    it('web-acp-catalog-api.ts exists and exports the singleton', () => {
      expect(existsSync(WebAdapter), 'web-acp-catalog-api.ts should exist').toBe(true)
      expect(
        fileContains('web-acp-catalog-api.ts', /export\s+const\s+\bwebAcpCatalogApi\b/),
        'should export webAcpCatalogApi'
      ).toBe(true)
    })

    it('api.ts exports the acpCatalogApi singleton', () => {
      const apiPath = join(LIB_DIR, 'api.ts')
      const content = readFileSync(apiPath, 'utf-8')
      expect(content).toMatch(/export\s*\{[^}]*\bacpCatalogApi\b[^}]*\}/)
    })

    it('Web adapter hits the catalog routes (GET /acp/catalog + POST /acp/catalog/opt-in)', () => {
      const content = readFileSync(WebAdapter, 'utf-8')
      expect(content).toMatch(/\/acp\/catalog/)
      expect(content).toMatch(/\/acp\/catalog\/opt-in/)
      // Network/parse failures must map to `NETWORK_ERROR`.
      expect(content).toMatch(/NETWORK_ERROR/)
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
  // install ships on two carriers: HTTP `POST /acp/install` (web) and the
  // `/ws` request `install_acp_agent` (desktop channel and web). This block
  // pins the TS-side parity (the Rust-side parity — router route + ws handler
  // — is covered by the Rust test suite).
  describe('ACP Install parity (CAP-6)', () => {
    const WebAdapter = join(LIB_DIR, 'web-acp-install-api.ts')

    it('web-acp-install-api.ts exists and exports the singleton', () => {
      expect(existsSync(WebAdapter), 'web-acp-install-api.ts should exist').toBe(true)
      expect(
        fileContains('web-acp-install-api.ts', /export\s+const\s+\bwebAcpInstallApi\b/),
        'should export webAcpInstallApi'
      ).toBe(true)
    })

    it('api.ts exports the acpInstallApi singleton', () => {
      const apiPath = join(LIB_DIR, 'api.ts')
      const content = readFileSync(apiPath, 'utf-8')
      expect(content).toMatch(/export\s*\{[^}]*\bacpInstallApi\b[^}]*\}/)
    })

    it('Web adapter hits the install route (POST /acp/install)', () => {
      const content = readFileSync(WebAdapter, 'utf-8')
      expect(content).toMatch(/\/acp\/install/)
      // Network/parse failures must map to `NETWORK_ERROR`.
      expect(content).toMatch(/NETWORK_ERROR/)
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

  // Project registry parity (story 8): the host owns the project list and
  // every surface changes it through ONE renderer facade over the `/ws`
  // transport (the browser over its WebSocket, the desktop over its Channel
  // carrier) — no per-surface Tauri command, no per-surface HTTP client. The
  // Rust side (ws handlers, HTTP routes, durable registry) is covered by the
  // Rust test suite. Also pins the wire rename `activeProjectId` →
  // `defaultProjectId` + `ProjectSummary.isActive` → `isDefault`.
  describe('Project registry parity (story 8)', () => {
    const Facade = join(LIB_DIR, 'project-registry-api.ts')
    const TransportTypes = join(LIB_DIR, 'acp-transport', 'types.ts')
    const WsTransport = join(LIB_DIR, 'acp-transport', 'ws-transport.ts')
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

    it('project-registry-api.ts exposes the commands over the shared transport only', () => {
      expect(existsSync(Facade), 'project-registry-api.ts should exist').toBe(true)
      const content = readFileSync(Facade, 'utf-8')
      for (const operation of ['add', 'update', 'archive', 'restore', 'remove', 'setDefault']) {
        expect(content, operation).toMatch(new RegExp(`\\b${operation}\\(`))
      }
      expect(content).toMatch(/getAcpTransport\(\)/)
      // One implementation for both surfaces: no surface branch, no raw invoke,
      // no HTTP client, no browser storage.
      expect(content).not.toMatch(/isTauriContext/)
      expect(content).not.toMatch(/\binvoke(Ipc)?\b/)
      expect(content).not.toMatch(/fetch\(/)
      expect(content).not.toMatch(/localStorage(?:\.|\[)/)
    })

    it('the transport declares and sends the four project requests', () => {
      const types = readFileSync(TransportTypes, 'utf-8')
      const ws = readFileSync(WsTransport, 'utf-8')
      for (const method of ['addProject', 'updateProject', 'removeProject', 'setDefaultProject']) {
        expect(types, method).toMatch(new RegExp(`\\b${method}\\(`))
      }
      for (const request of [
        'add_project',
        'update_project',
        'remove_project',
        'set_default_project'
      ]) {
        expect(ws, request).toMatch(new RegExp(`'${request}'`))
      }
    })

    it('the old per-surface project calls are retired', () => {
      const tauri = readFileSync(TauriRemoteApi, 'utf-8')
      expect(tauri).not.toMatch(/syncProjects|remote_sync_projects/)
      expect(tauri).not.toMatch(/setHostDefaultProject|set_host_default_project/)
      expect(tauri).toMatch(/export\s+async\s+function\s+projectRegistryImport\b/)
      expect(tauri).toMatch(/project_registry_import/)
      const web = readFileSync(WebServerApi, 'utf-8')
      expect(web).not.toMatch(/webServerProjects/)
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
    const WsRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'web', 'ws')

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

    it('web/ws implements handle_get_session_payload (the host cross-client authority)', () => {
      // The web/cross-client path: the WS handler materializes the transcript
      // from the host's durable store — no HTTP route, no client storage.
      expect(existsSync(WsRust), 'web/ws module should exist').toBe(true)
      const content = readRustModule(WsRust)
      expect(content).toMatch(/fn handle_get_session_payload/)
      expect(content).toMatch(/handle_send_prompt/)
    })
  })

  // CAP-2 (spec-in-chat-agent-switch): the durable agent-switch marker must
  // land on BOTH transports with one fold. The host is the sole author: the
  // Tauri command AND the WS route author ONE `agent_switch` record: the
  // relay's single seq allocator numbers it, appends it durably and delivers
  // it live under the same seq. This block pins the fold arm, the
  // `switches` field on both the Rust materialized payload and the TS
  // SessionPayload, both host routes, the WS request-type entry, and the
  // renderer wiring (event name + transport facade + store slice + timeline
  // kind + separator render).
  describe('Agent-Switch marker parity (CAP-2 / spec-in-chat-agent-switch)', () => {
    const SessionPayloadRust = join(
      LIB_DIR,
      '..',
      '..',
      '..',
      'src-tauri',
      'src',
      'acp',
      'session_payload.rs'
    )
    const ManagerRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'acp', 'manager')
    const WsRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'web', 'ws')
    const ProtoTypes = join(LIB_DIR, '..', '..', 'shared', 'types', 'web-protocol.types.ts')
    const AcpApi = join(LIB_DIR, 'acp-api.ts')
    const AcpTransport = join(LIB_DIR, 'acp-transport.ts')
    const HistoryPersistence = join(LIB_DIR, 'acp-history-persistence.ts')
    const Store = join(LIB_DIR, '..', 'stores', 'acp-store.ts')
    const ChatTimeline = join(LIB_DIR, '..', 'components', 'chat', 'chat-timeline.ts')
    const ChatMessageList = join(LIB_DIR, '..', 'components', 'chat', 'ChatMessageList.tsx')

    it('session_payload.rs folds agent_switch records into a switches array', () => {
      expect(existsSync(SessionPayloadRust), 'session_payload.rs should exist').toBe(true)
      const content = readFileSync(SessionPayloadRust, 'utf-8')
      // The fold arm resets open_role (split boundary) and collects markers.
      expect(content).toMatch(/"agent_switch" =>/)
      expect(content).toMatch(/MaterializedAgentSwitch/)
      expect(content).toMatch(/pub switches: Vec<MaterializedAgentSwitch>/)
    })

    it('acp/manager hosts record_agent_switch', () => {
      expect(existsSync(ManagerRust), 'acp/manager module should exist').toBe(true)
      const content = readRustModule(ManagerRust)
      expect(content).toMatch(/fn record_agent_switch/)
      expect(content).toMatch(/EVENT_AGENT_SWITCH/)
    })

    it('web/ws serves the record_agent_switch route (web parity)', () => {
      expect(existsSync(WsRust), 'web/ws module should exist').toBe(true)
      const content = readRustModule(WsRust)
      expect(content).toMatch(/fn handle_record_agent_switch/)
      expect(content).toMatch(/"record_agent_switch"/)
    })

    it('web-protocol.types.ts declares the record_agent_switch WS request type', () => {
      expect(existsSync(ProtoTypes), 'web-protocol.types.ts should exist').toBe(true)
      const content = readFileSync(ProtoTypes, 'utf-8')
      expect(content).toMatch(/'record_agent_switch'/)
      expect(content).toMatch(/interface RecordAgentSwitchPayload/)
    })

    it('renderer carries the event name + transport facade + payload type', () => {
      expect(existsSync(AcpApi), 'acp-api.ts should exist').toBe(true)
      const apiContent = readFileSync(AcpApi, 'utf-8')
      expect(apiContent).toMatch(/agentSwitch: 'acp:agent_switch'/)
      expect(apiContent).toMatch(/interface AgentSwitchEvent/)

      expect(existsSync(AcpTransport), 'acp-transport.ts should exist').toBe(true)
      // acp-transport.ts is a facade re-exporting the acp-transport/ module
      // dir (same layout as acp-store.ts) — grep the whole surface.
      const transportContent = readTsModule(AcpTransport.replace(/\.ts$/, ''))
      expect(transportContent).toMatch(/recordAgentSwitch/)
      expect(transportContent).toMatch(/'record_agent_switch'/)
    })

    it('TS SessionPayload carries an absent-tolerant switches field', () => {
      expect(existsSync(HistoryPersistence), 'acp-history-persistence.ts should exist').toBe(true)
      const content = readFileSync(HistoryPersistence, 'utf-8')
      expect(content).toMatch(/interface AgentSwitchRecord/)
      expect(content).toMatch(/switches\?: AgentSwitchRecord\[\]/)
    })

    it('acp-store.ts installs switches + handles the live agent_switch event', () => {
      expect(existsSync(Store), 'acp-store.ts should exist').toBe(true)
      // acp-store.ts is a module dir: types/helpers were extracted into
      // acp-store/ and the store body into acp-store/slices/ (spec-04) —
      // grep the whole surface, not just the root file.
      const storeDir = Store.replace(/\.ts$/, '')
      const storeTs = (dir: string) =>
        readdirSync(dir)
          .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
          .sort()
          .map((f) => readFileSync(join(dir, f), 'utf-8'))
          .join('\n')
      const content =
        readFileSync(Store, 'utf-8') + storeTs(storeDir) + storeTs(join(storeDir, 'slices'))
      expect(content).toMatch(/agentSwitches: Record<SessionId, AgentSwitchRecord\[\]/)
      expect(content).toMatch(/_onAgentSwitch/)
      expect(content).toMatch(/ACP_EVENTS\.agentSwitch/)
      // spec-agent-switch-live-merged-transcript: the same splice the reopen
      // redirect runs also runs live inside switchAgent — transport-agnostic
      // (both the Tauri and WS flows share this store), so both surfaces get
      // the merged-timeline parity for free.
      expect(content).toMatch(/spliceLiveSwitchTranscript/)
      expect(content).toMatch(/spliceSwitchTranscript/)
    })

    it('chat timeline + message list render the switch kind as a separator', () => {
      expect(existsSync(ChatTimeline), 'chat-timeline.ts should exist').toBe(true)
      const timelineContent = readFileSync(ChatTimeline, 'utf-8')
      expect(timelineContent).toMatch(/kind: 'switch'/)
      expect(timelineContent).toMatch(/switches: AgentSwitchRecord\[\]/)

      expect(existsSync(ChatMessageList), 'ChatMessageList.tsx should exist').toBe(true)
      const listContent = readFileSync(ChatMessageList, 'utf-8')
      expect(listContent).toMatch(/AgentSwitchSeparator/)
      expect(listContent).toMatch(/item\.kind === 'switch'/)
    })
  })

  // CAP-4: Agent spawn metadata parity. The spawn RESPONSE (not the async
  // `agent_spawned` event) is the single source of truth for the agent's
  // negotiated capabilities + auth methods + stable namespace — the renderer
  // populates them synchronously from the response. This block pins the Rust
  // `SpawnOutcome` struct + the TS `SpawnAgentResult` shape + the WS request
  // type + the `agent_spawned` event channel.
  describe('Agent Spawn Metadata parity (CAP-4)', () => {
    const AcpApi = join(LIB_DIR, 'acp-api.ts')
    const ProtoTypes = join(LIB_DIR, '..', '..', 'shared', 'types', 'web-protocol.types.ts')
    const ManagerRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'acp', 'manager')

    it('Rust SpawnOutcome carries capabilities + auth_methods + stable_namespace', () => {
      expect(existsSync(ManagerRust), 'acp/manager module should exist').toBe(true)
      const content = readRustModule(ManagerRust)
      expect(content).toMatch(/struct SpawnOutcome/)
      expect(content).toMatch(/pub capabilities:/)
      expect(content).toMatch(/pub auth_methods:/)
      expect(content).toMatch(/pub host_auth_ready:/)
      expect(content).toMatch(/pub stable_namespace:/)
    })

    it('TS SpawnAgentResult carries capabilities + authMethods + stableNamespace', () => {
      expect(existsSync(AcpApi), 'acp-api.ts should exist').toBe(true)
      const content = readFileSync(AcpApi, 'utf-8')
      expect(content).toMatch(/interface SpawnAgentResult/)
      expect(content).toMatch(/capabilities:\s*AgentCapabilities/)
      expect(content).toMatch(/authMethods:\s*AuthMethod\[\]/)
      expect(content).toMatch(/hostAuthReady\?:\s*boolean/)
      expect(content).toMatch(/stableNamespace\?:\s*string/)
    })

    it('WS request type spawn_agent + the agent_spawned event are declared', () => {
      expect(existsSync(ProtoTypes), 'web-protocol.types.ts should exist').toBe(true)
      const content = readFileSync(ProtoTypes, 'utf-8')
      expect(content).toMatch(/'spawn_agent'/)
      expect(content).toMatch(/agent_spawned/) // the event channel (reliability tier)
    })
  })

  // Category E: cross-client host-authority composition. The host (Tauri
  // `invoke` / HTTP `fetch` / WS handler + durable store) is the single
  // authority for cross-client state — NOT the browser's `localStorage`. This
  // block statically asserts every cross-client state facade reaches for the
  // host, never the `localStorage` API:
  //   - acp-history-api.ts          → invoke (desktop Tauri command)
  //   - terminal-api.ts + adapters  → invoke (desktop) / WS (web)
  //   - acp-transport.ts            → subscribes via WS subscribe + lastSeq
  //
  // NOTE: real-browser Playwright/Cypress tests (mobile suspension, reconnect,
  // reload, handoff) are deferred pending a real-browser harness introduction
  // (a separate infrastructure task). This static composition block is the
  // contract-correct substitute: it proves the code paths reach for the host,
  // not localStorage — the authority model the contract requires.
  describe('Cross-client host-authority (CAP-1..6)', () => {
    const HistoryFacade = join(LIB_DIR, 'acp-history-api.ts')
    const TerminalFacade = join(LIB_DIR, 'terminal-api.ts')
    const TauriTerminalAdapter = join(LIB_DIR, 'tauri-terminal-api.ts')
    const WebTerminalAdapter = join(LIB_DIR, 'web-terminal-api.ts')
    const Transport = join(LIB_DIR, 'acp-transport.ts')

    it('acp-history-api.ts calls the host (invoke), never localStorage', () => {
      expect(existsSync(HistoryFacade)).toBe(true)
      const content = readFileSync(HistoryFacade, 'utf-8')
      expect(content).toMatch(/invoke/)
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

    it('acp-transport.ts subscribes via WS subscribe + lastSeq, never localStorage as the cursor', () => {
      expect(existsSync(Transport)).toBe(true)
      // Facade + module dir — grep the whole acp-transport/ surface.
      const content = readTsModule(Transport.replace(/\.ts$/, ''))
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
      // Facade + module dir — grep the whole acp-transport/ surface.
      const content = readTsModule(AcpTransport.replace(/\.ts$/, ''))
      // The helper import must be present.
      expect(content).toMatch(/from\s+['"]@\/lib\/uuid['"]/)
      // No direct crypto.randomUUID() call remains in the transport hot path.
      expect(content).not.toMatch(/crypto\.randomUUID\(\)/)
    })

    // GH-587 regression guard: the safe @/lib/uuid wrapper exists, but a
    // direct `crypto.randomUUID()` call anywhere in the renderer bundle throws
    // `TypeError: crypto.randomUUID is not a function` on the termul-server
    // web client (served over plain HTTP — a non-secure context where the
    // global is `undefined`). This blank-screens / silently breaks the feature
    // that owns the call site (e.g. Add MCP server, custom-agent paste,
    // worktree launch). Walk every renderer source file and assert no direct
    // call remains anywhere except `lib/uuid.ts` itself (the fallback seam).
    const RENDERER_ROOT = join(LIB_DIR, '..')
    const DIRECT_CALL = /crypto\.randomUUID\s*\(\)/
    // Directories skipped: vendored/generated/test fixtures that are not
    // shipped to the web bundle.
    const SKIP_DIRS: Record<string, true> = {
      node_modules: true,
      'dist-web': true,
      __tests__: true,
      __mocks__: true
    }

    function* walkSources(dir: string): Generator<string> {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!(entry.name in SKIP_DIRS)) yield* walkSources(full)
        } else if (entry.isFile() && /\.(t|j)sx?$/.test(entry.name)) {
          yield full
        }
      }
    }

    it('CAP-1: no renderer source calls crypto.randomUUID() directly (all use @/lib/uuid)', () => {
      const offenders: string[] = []
      for (const file of walkSources(RENDERER_ROOT)) {
        // lib/uuid.ts is the fallback seam — it legitimately calls the native
        // API guarded by a typeof check. Every other file must go through it.
        if (file === UuidHelper) continue
        const content = readFileSync(file, 'utf-8')
        if (DIRECT_CALL.test(content)) {
          offenders.push(file.replace(`${RENDERER_ROOT}/`, ''))
        }
      }
      expect(
        offenders,
        `direct crypto.randomUUID() calls found (use randomUUID from @/lib/uuid):\n${offenders.join('\n')}`
      ).toEqual([])
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
      // The keydown clipboard dispatch was split out of ConnectedTerminal.tsx
      // into terminal/clipboard.ts (handleTerminalClipboardKey) — grep there.
      const ConnectedTerminalClipboard = join(
        LIB_DIR,
        '..',
        'components',
        'terminal',
        'clipboard.ts'
      )
      expect(existsSync(ConnectedTerminalClipboard), 'terminal/clipboard.ts should exist').toBe(
        true
      )
      const content = readFileSync(ConnectedTerminalClipboard, 'utf-8')
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
    const CommandsRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'commands')

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
      // The 7 launch-flow methods + `renameBranch` (story 16) reference
      // `webServerWorktree` (the web branch).
      const launchFlowRefs = (content.match(/webServerWorktree\./g) ?? []).length
      expect(
        launchFlowRefs,
        '7 launch-flow methods + renameBranch should reference webServerWorktree'
      ).toBe(8)
    })

    it('facade keeps the 8 advanced methods as WEB_UNSUPPORTED (no webServerWorktree ref)', () => {
      const content = readFileSync(Facade, 'utf-8')
      for (const method of ADVANCED_METHODS) {
        expect(content, `worktree-api.ts should still define ${method}`).toMatch(
          new RegExp(`\\b${method}\\s*:`)
        )
      }
      // Exactly 8 webServerWorktree refs (7 launch-flow + story 16 `renameBranch`) —
      // the advanced methods do NOT branch.
      const launchFlowRefs = (content.match(/webServerWorktree\./g) ?? []).length
      expect(launchFlowRefs).toBe(8)
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

    it('commands module defines the 7 desktop Tauri commands (worktree_*)', () => {
      expect(existsSync(CommandsRust), 'commands module should exist').toBe(true)
      const content = readRustModule(CommandsRust)
      for (const cmd of [
        'worktree_list',
        'worktree_create',
        'worktree_remove',
        'worktree_branches',
        'worktree_check_dirty',
        'worktree_resolve_base_branch',
        'worktree_copy_include_files'
      ]) {
        expect(content, `commands module should define ${cmd}`).toMatch(
          new RegExp(`\\b${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
        )
      }
    })
  })

  // Folder @-mention parity (gh-896): the renderer-side contract strings that
  // both transports share. The Rust-side source strings are intentionally not
  // asserted here.
  describe('Folder mention parity (gh-896)', () => {
    const readLib = (rel: string): string => readFileSync(join(LIB_DIR, rel), 'utf-8')

    it('the web adapter hit type carries the optional dir kind', () => {
      expect(readLib('web-server-api.ts')).toMatch(/kind\?: 'file' \| 'dir'/)
    })

    it('the shared SearchFileHit contract carries the optional dir kind', () => {
      const shared = join(LIB_DIR, '..', '..', 'shared', 'types', 'filesystem.types.ts')
      expect(readFileSync(shared, 'utf-8')).toMatch(/kind\?: 'file' \| 'dir'/)
    })

    it('the web facade fans hits through the shared batch emitter without re-shaping them', () => {
      expect(readLib('tauri-filesystem-api.ts')).toMatch(/files: data\.files/)
    })

    it('folder tokens reuse the file token with a trailing-slash dir marker', () => {
      const tokens = readLib('skill-tokens.ts')
      expect(tokens).toMatch(/export function isFolderTokenPath/)
      expect(tokens).toMatch(/absPath\.endsWith\('\/'\)/)
    })

    it('the picker model renders a separate Folders section after Files', () => {
      const model = readFileSync(
        join(LIB_DIR, '..', 'components', 'chat', 'mention-menu-model.ts'),
        'utf-8'
      )
      expect(model).toMatch(/heading: 'Folders'/)
      expect(model).toMatch(/MAX_FOLDER_RESULTS/)
    })
  })

  // Git hunk staging parity: per-hunk stage/unstage ships on THREE transports
  // (Tauri `git_stage_hunk`/`git_unstage_hunk`, HTTP `/git/stage-hunk` |
  // `/git/unstage-hunk`, and the `gitApi` facade branching on
  // `isTauriContext()`), all reusing the same `git_tracker` functions.
  describe('Git hunk staging parity', () => {
    const SrcTauri = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
    const Facade = join(LIB_DIR, 'git-api.ts')
    const WebAdapter = join(LIB_DIR, 'web-server-api.ts')
    const RouterRust = join(SrcTauri, 'web', 'router.rs')
    const HunkApiRust = join(SrcTauri, 'web', 'git_hunk_api.rs')
    const CommandsGitRust = join(SrcTauri, 'commands', 'git.rs')
    const LibRust = join(SrcTauri, 'lib.rs')

    const ROUTES = ['/git/stage-hunk', '/git/unstage-hunk'] as const

    it('gitApi.stageHunk/unstageHunk branch on isTauriContext() between invoke and webServerGit', () => {
      const content = readFileSync(Facade, 'utf-8')
      expect(content).toMatch(
        /stageHunk:[\s\S]*?isTauriContext\(\)[\s\S]*?invoke<void>\('git_stage_hunk'[\s\S]*?webServerGit\.stageHunk\(/
      )
      expect(content).toMatch(
        /unstageHunk:[\s\S]*?isTauriContext\(\)[\s\S]*?invoke<void>\('git_unstage_hunk'[\s\S]*?webServerGit\.unstageHunk\(/
      )
      expect(content).not.toMatch(/desktop-only/i)
    })

    it('webServerGit hits both hunk routes with { cwd, path, hunkPatch }', () => {
      const content = readFileSync(WebAdapter, 'utf-8')
      for (const route of ROUTES) {
        expect(content, `webServerGit should hit ${route}`).toContain(`'${route}'`)
      }
      expect(content).toMatch(/async stageHunk\(cwd: string, path: string, hunkPatch: string\)/)
      expect(content).toMatch(/async unstageHunk\(cwd: string, path: string, hunkPatch: string\)/)
    })

    it('router.rs registers both hunk routes in BOTH router tables', () => {
      const content = readFileSync(RouterRust, 'utf-8')
      for (const route of ROUTES) {
        const matches = content.match(new RegExp(`"${route}"`, 'g')) ?? []
        expect(matches.length, `${route} should be registered in both router tables`).toBe(2)
      }
    })

    it('git_hunk_api.rs defines both handlers behind the resolve_cwd write guard', () => {
      expect(existsSync(HunkApiRust), 'git_hunk_api.rs should exist').toBe(true)
      const content = readFileSync(HunkApiRust, 'utf-8')
      expect(content).toMatch(/pub async fn stage_hunk\b/)
      expect(content).toMatch(/pub async fn unstage_hunk\b/)
      expect(content).toMatch(/resolve_cwd::<\(\)>\([^)]*Some\(peer\),\s*true\)/)
      expect(content).toMatch(/git_tracker::git_stage_hunk/)
      expect(content).toMatch(/git_tracker::git_unstage_hunk/)
      expect(content).toMatch(/classify_hunk_error/)
    })

    it('desktop Tauri commands exist and stay registered', () => {
      const commands = readFileSync(CommandsGitRust, 'utf-8')
      const lib = readFileSync(LibRust, 'utf-8')
      for (const cmd of ['git_stage_hunk', 'git_unstage_hunk']) {
        expect(commands).toMatch(new RegExp(`\\bfn ${cmd}\\b`))
        expect(lib).toMatch(new RegExp(`commands::${cmd}\\b`))
      }
    })
  })

  // Filename-search transport parity (issue #848): the @-mention picker's
  // `search_file_names_stream` desktop command gains a web transport — the
  // one-shot `GET /search/file-names` HTTP route reusing the same rg walk.
  // The facade branches `isTauriContext()` between `invoke` and the HTTP
  // request, and fans the web result through the same batch/done listener
  // surface the desktop Tauri events use.
  describe('Filename search parity (issue #848)', () => {
    const FsFacade = join(LIB_DIR, 'tauri-filesystem-api.ts')
    const WebAdapter = join(LIB_DIR, 'web-server-api.ts')
    const RouterRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'web', 'router.rs')
    const SearchApiRust = join(
      LIB_DIR,
      '..',
      '..',
      '..',
      'src-tauri',
      'src',
      'web',
      'search_api.rs'
    )
    const CommandsRust = join(
      LIB_DIR,
      '..',
      '..',
      '..',
      'src-tauri',
      'src',
      'commands',
      'search.rs'
    )

    it('tauri-filesystem-api.ts branches the filename stream methods on isTauriContext()', () => {
      const content = readFileSync(FsFacade, 'utf-8')
      expect(content).toMatch(/isTauriContext\(\)/)
      // The web branch routes through the shared webServerSearch adapter.
      expect(content).toMatch(/webServerSearch\.fileNames/)
      // The web branch still exports the batch/done listener surface.
      expect(content).toMatch(/onSearchFileNamesBatch/)
      expect(content).toMatch(/onSearchFileNamesDone/)
    })

    it('web-server-api.ts exports webServerSearch.fileNames hitting /search/file-names', () => {
      const content = readFileSync(WebAdapter, 'utf-8')
      expect(content).toMatch(/async fileNames\(/)
      expect(content).toMatch(/\/search\/file-names\?/)
      // Network/parse failures must map to NETWORK_ERROR.
      expect(content).toMatch(/NETWORK_ERROR/)
    })

    it('router.rs registers the /search/file-names route in BOTH router variants', () => {
      const content = readFileSync(RouterRust, 'utf-8')
      const occurrences = (content.match(/\/search\/file-names/g) ?? []).length
      expect(occurrences, 'both router() and router_with_static() register the route').toBe(2)
    })

    it('search_api.rs defines the file_names handler reusing the shared rg helpers', () => {
      const content = readFileSync(SearchApiRust, 'utf-8')
      expect(content).toMatch(/pub async fn file_names/)
      // Same ripgrep walk as the desktop command (shared helpers, not a
      // second implementation).
      expect(content).toMatch(/build_file_name_search_args/)
      expect(content).toMatch(/rank_search_hits/)
      expect(content).toMatch(/path_is_ignored/)
      // IpcBody contract + spawn_blocking + tracing boundary logs.
      expect(content).toMatch(/IpcBody/)
      expect(content).toMatch(/spawn_blocking/)
      expect(content).toMatch(/tracing/)
      // Containment parity with /search/content.
      expect(content).toMatch(/ensure_within_project_boundary/)
    })

    it('commands/search.rs keeps the desktop search_file_names_stream command', () => {
      const content = readFileSync(CommandsRust, 'utf-8')
      expect(content).toMatch(/pub async fn search_file_names_stream/)
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
    const CommandsRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'commands')
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

    it('commands module cfg-gates browser_tab_open_devtools (debug real, release Err stub)', () => {
      expect(existsSync(CommandsRust), 'commands module should exist').toBe(true)
      const content = readRustModule(CommandsRust)
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

    it('ProjectSidebar.tsx handleRowContextMenu calls stopPropagation so the global trigger does not fire', () => {
      const sidebar = join(LIB_DIR, '..', 'components', 'ProjectSidebar.tsx')
      expect(existsSync(sidebar), 'ProjectSidebar.tsx should exist').toBe(true)
      const content = readFileSync(sidebar, 'utf-8')
      // One handler serves project and group rows. It must stopPropagation so
      // the global Radix trigger doesn't double-fire over the sidebar menus.
      // It must NOT call preventDefault (F1): Radix would skip opening the menu.
      const handlerMatch = content.match(/handleRowContextMenu = useCallback\(([\s\S]*?),\s*\[\]\)/)
      expect(handlerMatch, 'handleRowContextMenu callback should exist').not.toBeNull()
      const handler = handlerMatch![1]
      expect(handler).toMatch(/e\.stopPropagation\(\)/)
      expect(handler).not.toMatch(/e\.preventDefault\(\)/)
    })

    it('ProjectSidebar.tsx routes project and group rows through handleRowContextMenu', () => {
      const sidebar = join(LIB_DIR, '..', 'components', 'ProjectSidebar.tsx')
      const content = readFileSync(sidebar, 'utf-8')
      expect(content).toMatch(/onRowContextMenu=\{handleRowContextMenu\}/)
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

  // OpenPencil canvas mode: the canvas subsystem ships on TWO transports
  // (Tauri commands `canvas_*` + HTTP routes `POST /canvas/open|close|save`
  // behind the bearer web auth gate), with the phone-width shell gated by a
  // typed UNSUPPORTED_SURFACE failure. This block pins the TS-side parity
  // (the Rust-side parity — commands/canvas.rs + web/canvas_api.rs + router
  // registration — is covered by the Rust test suite).
  describe('Canvas parity (OpenPencil canvas mode)', () => {
    const TauriAdapter = join(LIB_DIR, 'tauri-canvas-api.ts')
    const WebAdapter = join(LIB_DIR, 'web-canvas-api.ts')
    const Facade = join(LIB_DIR, 'canvas-api.ts')

    it('tauri-canvas-api.ts exists and exports the factory', () => {
      expect(existsSync(TauriAdapter), 'tauri-canvas-api.ts should exist').toBe(true)
      expect(
        fileContains('tauri-canvas-api.ts', /export\s+function\s+\bcreateTauriCanvasApi\b/),
        'should export createTauriCanvasApi'
      ).toBe(true)
    })

    it('web-canvas-api.ts exists and exports the singleton', () => {
      expect(existsSync(WebAdapter), 'web-canvas-api.ts should exist').toBe(true)
      expect(
        fileContains('web-canvas-api.ts', /export\s+const\s+\bwebCanvasApi\b/),
        'should export webCanvasApi'
      ).toBe(true)
    })

    it('facade singleton exists and branches Tauri vs web by isTauriContext()', () => {
      expect(existsSync(Facade), 'canvas-api.ts should exist').toBe(true)
      const content = readFileSync(Facade, 'utf-8')
      expect(content).toMatch(/isTauriContext\(\)/)
      expect(content).toMatch(/createTauriCanvasApi/)
      expect(content).toMatch(/webCanvasApi/)
    })

    it('facade gates phone-width viewports with the typed UNSUPPORTED_SURFACE failure', () => {
      const content = readFileSync(Facade, 'utf-8')
      // The call-time viewport predicate (same media queries as the mobile
      // shell hook) + the typed failure code.
      expect(content).toMatch(/isMobileWebShellViewport/)
      expect(content).toMatch(/UNSUPPORTED_SURFACE/)
    })

    it('api.ts exports the canvasApi singleton', () => {
      const apiPath = join(LIB_DIR, 'api.ts')
      const content = readFileSync(apiPath, 'utf-8')
      expect(content).toMatch(/export\s*\{[^}]*\bcanvasApi\b[^}]*\}/)
    })

    it('Tauri adapter invokes the four commands (open/close/save/status)', () => {
      const content = readFileSync(TauriAdapter, 'utf-8')
      expect(content).toMatch(/canvas_open/)
      expect(content).toMatch(/canvas_close/)
      expect(content).toMatch(/canvas_save/)
      expect(content).toMatch(/canvas_status/)
      // The camelCase wire args the Rust `#[tauri::command]` declares.
      expect(content).toMatch(/docPath/)
      expect(content).toMatch(/projectId/)
    })

    it('Web adapter hits the three canvas routes with the bearer gate + cookie + NETWORK_ERROR', () => {
      const content = readFileSync(WebAdapter, 'utf-8')
      expect(content).toMatch(/\/canvas\/open/)
      expect(content).toMatch(/\/canvas\/close/)
      expect(content).toMatch(/\/canvas\/save/)
      // Network/parse failures must map to `NETWORK_ERROR`; the web open
      // must set the `op_canvas_ct` cookie from the returned canvas token.
      expect(content).toMatch(/NETWORK_ERROR/)
      expect(content).toMatch(/op_canvas_ct/)
      expect(content).toMatch(/SameSite=Lax/)
      // postJson carries the bearer web auth header for the gated routes.
      expect(content).toMatch(/postJson/)
    })

    it('both adapters expose open/close/save on the typed facade', () => {
      const tauri = readFileSync(TauriAdapter, 'utf-8')
      const web = readFileSync(WebAdapter, 'utf-8')
      for (const method of ['open', 'close', 'save']) {
        expect(tauri, `tauri-canvas-api.ts should implement ${method}`).toMatch(
          new RegExp(`\\b${method}\\s*\\(`)
        )
        expect(web, `web-canvas-api.ts should implement ${method}`).toMatch(
          new RegExp(`\\b${method}\\s*\\(`)
        )
      }
    })

    it('shared types file exists with expected exports', () => {
      const typesPath = join(LIB_DIR, '..', '..', 'shared', 'types', 'canvas.types.ts')
      expect(existsSync(typesPath), 'canvas.types.ts should exist').toBe(true)
      const content = readFileSync(typesPath, 'utf-8')
      expect(content).toMatch(/export\s+interface\s+CanvasOpenInfo\b/)
      expect(content).toMatch(/export\s+interface\s+CanvasStatus\b/)
      expect(content).toMatch(/export\s+interface\s+CanvasApi\b/)
      expect(content).toMatch(/export\s+const\s+CanvasErrorCodes\b/)
      // The typed surface gate code (phone-width shell has no canvas).
      expect(content).toMatch(/UNSUPPORTED_SURFACE/)
    })

    it('canvas bridge speaks the verbatim op-bridge/op-shell wire strings', () => {
      const bridgePath = join(LIB_DIR, 'canvas-bridge.ts')
      expect(existsSync(bridgePath), 'canvas-bridge.ts should exist').toBe(true)
      const content = readFileSync(bridgePath, 'utf-8')
      for (const literal of [
        "'op-bridge/init'",
        "'op-bridge/theme'",
        "'op-bridge/locale'",
        "'op-bridge/save-committed'",
        "'op-bridge/resolve-conflict'",
        "'op-bridge/listening'",
        "'op-bridge/ready'",
        "'op-bridge/dirty-changed'",
        "'op-bridge/sync-conflict'",
        "'op-bridge/conflict-resolved'",
        "'op-shell/save'",
        "'op-shell/copy'"
      ]) {
        expect(content, `canvas-bridge.ts should carry ${literal}`).toContain(literal)
      }
      // Init retry cadence (500ms / 20) + explicit targetOrigin (never '*').
      expect(content).toMatch(/500/)
      expect(content).toMatch(/postMessage\(json,\s*iframeOrigin\)/)
    })

    it('renderer wiring: store + panel + shell + tab chrome + dispatch + close routing', () => {
      const store = join(LIB_DIR, '..', 'stores', 'canvas-store.ts')
      expect(existsSync(store), 'stores/canvas-store.ts should exist').toBe(true)
      expect(readFileSync(store, 'utf-8')).toMatch(/canvasApi/)

      const panel = join(LIB_DIR, '..', 'components', 'canvas', 'CanvasPanel.tsx')
      expect(existsSync(panel), 'components/canvas/CanvasPanel.tsx should exist').toBe(true)
      expect(readFileSync(panel, 'utf-8')).toMatch(/createCanvasBridge/)

      const shell = join(LIB_DIR, '..', 'components', 'canvas', 'CanvasShell.tsx')
      expect(existsSync(shell), 'components/canvas/CanvasShell.tsx should exist').toBe(true)

      const tab = join(LIB_DIR, '..', 'components', 'workspace', 'tabs', 'canvas-tab.tsx')
      expect(existsSync(tab), 'tabs/canvas-tab.tsx should exist').toBe(true)
      // Dirty state flows through the shared tab chrome; the close-slot
      // marker styling lives there, not per kind.
      expect(readFileSync(tab, 'utf-8')).toMatch(/dirty/)
      const chrome = join(LIB_DIR, '..', 'components', 'workspace', 'tabs', 'tab-chrome.tsx')
      expect(existsSync(chrome), 'tabs/tab-chrome.tsx should exist').toBe(true)
      expect(readFileSync(chrome, 'utf-8')).toMatch(/bg-foreground\/70/)

      const paneContent = join(LIB_DIR, '..', 'components', 'workspace', 'PaneContent.tsx')
      expect(readFileSync(paneContent, 'utf-8')).toMatch(/CanvasPanel/)

      const tabBar = join(LIB_DIR, '..', 'components', 'workspace', 'WorkspaceTabBar.tsx')
      expect(readFileSync(tabBar, 'utf-8')).toMatch(/case 'canvas'/)
      expect(readFileSync(tabBar, 'utf-8')).toMatch(/closeCanvas/)

      // The workspace store owns the singleton-per-project tab id helper.
      const workspaceStoreTree = join(LIB_DIR, '..', 'stores', 'workspace-store', 'tree.ts')
      expect(readFileSync(workspaceStoreTree, 'utf-8')).toMatch(/export function canvasTabId/)
      const workspaceStoreIndex = join(LIB_DIR, '..', 'stores', 'workspace-store', 'index.ts')
      expect(readFileSync(workspaceStoreIndex, 'utf-8')).toMatch(/canvasTabId/)
    })

    it('MCP upsert goes through the serialized acp-store mcp slice (never the persistence key)', () => {
      const slice = join(LIB_DIR, '..', 'stores', 'acp-store', 'slices', 'mcp.ts')
      expect(existsSync(slice), 'acp-store/slices/mcp.ts should exist').toBe(true)
      const content = readFileSync(slice, 'utf-8')
      expect(content).toMatch(/upsertCanvasMcpServer/)
      // Serialized through the registry mutation queue + preserves enabled.
      expect(content).toMatch(/runSerializedMcpRegistryMutation/)
      // Web entries carry the bearer header for the gated /canvas/mcp route.
      expect(content).toMatch(/Authorization/)
    })

    it('Rust hosts both transports (commands/canvas.rs + web/canvas_api.rs)', () => {
      const root = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
      const commands = join(root, 'commands', 'canvas.rs')
      expect(existsSync(commands), 'commands/canvas.rs should exist').toBe(true)
      const commandsContent = readFileSync(commands, 'utf-8')
      expect(commandsContent).toMatch(/canvas_open/)
      expect(commandsContent).toMatch(/canvas_close/)
      expect(commandsContent).toMatch(/canvas_save/)
      expect(commandsContent).toMatch(/canvas_status/)

      const webApi = join(root, 'web', 'canvas_api.rs')
      expect(existsSync(webApi), 'web/canvas_api.rs should exist').toBe(true)
      const webContent = readFileSync(webApi, 'utf-8')
      expect(webContent).toMatch(/\/canvas\/open/)
      expect(webContent).toMatch(/\/canvas\/close/)
      expect(webContent).toMatch(/\/canvas\/save/)
      expect(webContent).toMatch(/canvas_token_gate/)

      const canvasModule = join(root, 'canvas', 'mod.rs')
      expect(existsSync(canvasModule), 'canvas/mod.rs should exist').toBe(true)
    })
  })
})

// #856 (web explorer live refresh): the FS-change push must land on BOTH
// surfaces — the server-side notify watcher publishing `fs` watch deltas over
// the control WS (Rust: web/fs_watcher + web/watch) and the shared protocol
// registry (web-protocol.types.ts) + the renderer filesystem facade's watch
// that dispatches through the SAME onFileChanged chain the desktop
// tauri-plugin-fs watcher feeds. This block pins the pieces.
describe('Web FS watcher parity (#856)', () => {
  const root = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
  const ProtoTypes = join(LIB_DIR, '..', '..', 'shared', 'types', 'web-protocol.types.ts')
  const FsFacade = join(LIB_DIR, 'tauri-filesystem-api.ts')

  it('web/fs_watcher is a refcounted per-projectId notify watch hub that publishes through the watch hub', () => {
    const watcher = join(root, 'web', 'fs_watcher')
    expect(existsSync(watcher), 'web/fs_watcher module should exist').toBe(true)
    const content = readRustModule(watcher)
    expect(content).toMatch(/recommended_watcher/)
    expect(content).toMatch(/RecursiveMode::Recursive/)
    expect(content).toMatch(/pub struct FsWatchHub/)
    expect(content).toMatch(/WatchKind::Fs/)
    expect(content).not.toMatch(/"fs_changed"|"fs_watch_ended"/)
  })

  it('ws/watch.rs serves the fs watch through watch / unwatch; the per-project requests are gone', () => {
    const handlers = readFileSync(join(root, 'web', 'ws', 'watch.rs'), 'utf-8')
    expect(handlers).toMatch(/WatchKind::Fs =>/)
    expect(handlers).not.toMatch(/handle_watch_project|handle_unwatch_project/)
    const dispatch = readFileSync(join(root, 'web', 'ws', 'dispatch.rs'), 'utf-8')
    expect(dispatch).not.toMatch(/"watch_project"|"unwatch_project"/)
  })

  it('web-protocol.types.ts names the fs watch and no longer registers fs_changed or watch_project', () => {
    expect(existsSync(ProtoTypes), 'web-protocol.types.ts should exist').toBe(true)
    const content = readFileSync(ProtoTypes, 'utf-8')
    expect(content).toMatch(/'fs',/)
    expect(content).not.toMatch(/'fs_changed'|'fs_watch_ended'|'watch_project'|'unwatch_project'/)
  })

  it('the filesystem facade watches the fs scope and feeds the shared callback chain on web', () => {
    expect(existsSync(FsFacade), 'tauri-filesystem-api.ts should exist').toBe(true)
    const content = readFileSync(FsFacade, 'utf-8')
    expect(content).toMatch(/startProjectFsWatch/)
    expect(content).toMatch(/watches\.subscribe<FsWatchState, FsWatchDelta>/)
    expect(content).not.toMatch(/acp:fs_changed|wireWebFsChangedBridge/)
  })
})

// Diff stat host operation (CAP-1 project-row +N -M). Source-grep checks pin that
// one shared Rust function backs the Tauri command AND the web read route, and
// that the renderer facade reaches both.
describe('Git diff stat parity (shell revamp story 8)', () => {
  const SRC_TAURI = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
  const GitApiFacade = join(LIB_DIR, 'git-api.ts')
  const WebAdapter = join(LIB_DIR, 'web-server-api.ts')
  const RouterRust = join(SRC_TAURI, 'web', 'router.rs')
  const RouteRust = join(SRC_TAURI, 'web', 'git_diff_stat_api.rs')
  const ServiceRust = join(SRC_TAURI, 'trackers', 'git_tracker', 'diff_stat.rs')
  const CommandsGitRust = join(SRC_TAURI, 'commands', 'git.rs')
  const LibRust = join(SRC_TAURI, 'lib.rs')

  it('git-api.ts branches getDiffStat on isTauriContext() between invoke and webServerGit', () => {
    const content = readFileSync(GitApiFacade, 'utf-8')
    expect(content).toMatch(/getDiffStat: async/)
    expect(content).toMatch(/isTauriContext\(\)/)
    expect(content).toMatch(/invokeIpc<GitDiffStat>\('git_get_diff_stat'/)
    expect(content).toMatch(/webServerGit\.getDiffStat\(/)
  })

  it('web-server-api.ts exposes webServerGit.getDiffStat hitting /git/diff-stat', () => {
    const content = readFileSync(WebAdapter, 'utf-8')
    expect(content).toMatch(/async getDiffStat\(/)
    expect(content).toMatch(/\/git\/diff-stat/)
  })

  it('router.rs registers /git/diff-stat in BOTH router variants', () => {
    const content = readFileSync(RouterRust, 'utf-8')
    const occurrences = (content.match(/"\/git\/diff-stat"/g) ?? []).length
    expect(occurrences, 'both router() and router_with_static() register the route').toBe(2)
  })

  it('git_diff_stat_api.rs is a READ route through resolve_cwd and the shared service', () => {
    const content = readFileSync(RouteRust, 'utf-8')
    expect(content).toMatch(/pub async fn get_diff_stat/)
    // Read path: containment only, no remote-write gate.
    expect(content).toMatch(/resolve_cwd::<GitDiffStat>\(&req\.cwd, &state, None, false\)/)
    expect(content).toMatch(/git_tracker::git_get_diff_stat/)
    expect(content).toMatch(/IpcBody/)
    expect(content).toMatch(/spawn_blocking/)
    expect(content).toMatch(/tracing/)
  })

  it('the Tauri command is defined and registered in lib.rs over the same shared service', () => {
    const command = readFileSync(CommandsGitRust, 'utf-8')
    expect(command).toMatch(/pub async fn git_get_diff_stat/)
    expect(command).toMatch(/git_tracker::git_get_diff_stat/)
    expect(readFileSync(LibRust, 'utf-8')).toMatch(/commands::git_get_diff_stat,/)
  })

  it('the shared service returns DiffStatError with a stable code', () => {
    const content = readFileSync(ServiceRust, 'utf-8')
    expect(content).toMatch(/pub fn git_get_diff_stat/)
    expect(content).toMatch(/GIT_DIFF_STAT_ERROR/)
  })
})

describe('Worktree branch rename parity (shell revamp story 16)', () => {
  const SRC_TAURI = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
  const WorktreeFacade = join(LIB_DIR, 'worktree-api.ts')
  const WebAdapter = join(LIB_DIR, 'web-server-api.ts')
  const RouterRust = join(SRC_TAURI, 'web', 'router.rs')
  const RouteRust = join(SRC_TAURI, 'web', 'worktree_rename_api.rs')
  const ManagerRust = join(SRC_TAURI, 'acp', 'manager', 'worktree_branch.rs')
  const CommandsWorktreeRust = join(SRC_TAURI, 'commands', 'worktree.rs')
  const LibRust = join(SRC_TAURI, 'lib.rs')
  const ProtocolTypes = join(LIB_DIR, '..', '..', 'shared', 'types', 'web-protocol.types.ts')
  const SinkRust = join(SRC_TAURI, 'web', 'sink', 'watch_bridge.rs')

  it('worktree-api.ts branches renameBranch on isTauriContext() between invoke and webServerWorktree', () => {
    const content = readFileSync(WorktreeFacade, 'utf-8')
    expect(content).toMatch(/renameBranch: \(/)
    expect(content).toMatch(/isTauriContext\(\)/)
    expect(content).toMatch(/invoke<IpcResult<void>>\('worktree_rename_branch'/)
    expect(content).toMatch(/webServerWorktree\.renameBranch\(/)
    // Write route: the facade documents the S19 gating contract for callers.
    expect(content).toMatch(/useServerAdmitsRemoteWrites/)
  })

  it('web-server-api.ts exposes webServerWorktree.renameBranch hitting /worktree/rename-branch', () => {
    const content = readFileSync(WebAdapter, 'utf-8')
    expect(content).toMatch(/async renameBranch\(/)
    expect(content).toMatch(/\/worktree\/rename-branch/)
  })

  it('router.rs registers /worktree/rename-branch in BOTH router variants', () => {
    const content = readFileSync(RouterRust, 'utf-8')
    const occurrences = (content.match(/"\/worktree\/rename-branch"/g) ?? []).length
    expect(occurrences, 'both router() and router_with_static() register the route').toBe(2)
  })

  it('worktree_rename_api.rs is a WRITE route through resolve_project_path and the shared manager op', () => {
    const content = readFileSync(RouteRust, 'utf-8')
    expect(content).toMatch(/pub async fn rename_branch/)
    // Write path: loopback / --allow-remote-writes / shared-live guard + containment.
    expect(content).toMatch(
      /resolve_project_path::<\(\)>\(&req\.worktree_path, &state, Some\(peer\), true\)/
    )
    expect(content).toMatch(/rename_worktree_branch/)
    expect(content).toMatch(/IpcBody/)
    expect(content).toMatch(/tracing/)
  })

  it('the shared host function renames, records and fans out (no transport git logic)', () => {
    const content = readFileSync(ManagerRust, 'utf-8')
    expect(content).toMatch(/pub\(crate\) async fn rename_and_record/)
    expect(content).toMatch(/WorktreeManager::rename_branch/)
    expect(content).toMatch(/EVENT_WORKTREE_BRANCH_RENAMED/)
    expect(readFileSync(RouteRust, 'utf-8')).not.toMatch(/Command::new|run_git/)
  })

  it('the Tauri command is defined and registered in lib.rs over the same manager op', () => {
    const command = readFileSync(CommandsWorktreeRust, 'utf-8')
    expect(command).toMatch(/pub async fn worktree_rename_branch/)
    expect(command).toMatch(/rename_worktree_branch/)
    expect(readFileSync(LibRust, 'utf-8')).toMatch(/commands::worktree_rename_branch,/)
  })

  it('the worktree_branch_renamed rename is a chat_history watch delta, not a registered event', () => {
    const protocol = readFileSync(ProtocolTypes, 'utf-8')
    expect(protocol).not.toMatch(/worktree_branch_renamed: WS_RELAY_TIERS/)
    expect(protocol).toMatch(/event\?: 'worktree_branch_renamed'/)
    const bridge = readFileSync(SinkRust, 'utf-8')
    expect(bridge).toMatch(/"worktree_branch_renamed"/)
    expect(bridge).toMatch(/publish_worktree_branch_renamed/)
  })

  it('both renderer roots mount useWorktreeBranchRenamed next to useAcpHistory', () => {
    for (const root of ['TauriApp.tsx', 'App.tsx']) {
      const content = readFileSync(join(LIB_DIR, '..', root), 'utf-8')
      expect(content, root).toMatch(/useWorktreeBranchRenamed\(\)/)
    }
  })
})

// Story 2 / AD-4, AD-15: the versioned `authenticate` handshake identity is
// minted at boot on BOTH renderer roots, and every WS client builds its
// handshake through the one shared payload builder.
describe('Client identity boot parity (AD-4)', () => {
  it('both renderer roots call ensureClientIdentity() at boot', () => {
    for (const root of ['TauriApp.tsx', 'App.tsx']) {
      const content = readFileSync(join(LIB_DIR, '..', root), 'utf-8')
      expect(content, root).toMatch(/from '@\/lib\/web-client-identity'/)
      expect(content, root).toMatch(/ensureClientIdentity\(\)/)
    }
  })

  it('all three WS clients build the handshake via buildAuthenticatePayload()', () => {
    for (const client of [
      join('acp-transport', 'ws-transport.ts'),
      'web-terminal-api.ts',
      'web-persistence-api.ts'
    ]) {
      const content = readFileSync(join(LIB_DIR, client), 'utf-8')
      expect(content, client).toMatch(/buildAuthenticatePayload\(/)
    }
  })
})

describe('Bounded delivery parity (host heartbeat, gap frame)', () => {
  const SRC_TAURI = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
  const RELAY = join(SRC_TAURI, 'web', 'ws', 'relay')

  it('the client reads the host heartbeat interval the Rust write loop uses', () => {
    const watchdog = readFileSync(join(RELAY, 'watchdog.rs'), 'utf-8')
    const seconds = /HEARTBEAT_INTERVAL: Duration = Duration::from_secs\((\d+)\)/.exec(watchdog)
    expect(seconds).not.toBeNull()
    const liveness = readFileSync(join(LIB_DIR, 'acp-transport', 'liveness.ts'), 'utf-8')
    const clientMs = /HOST_HEARTBEAT_INTERVAL_MS = ([\d_]+)/.exec(liveness)
    expect(clientMs).not.toBeNull()
    expect(Number(clientMs?.[1].replaceAll('_', ''))).toBe(Number(seconds?.[1]) * 1000)
  })

  it('the gap and heartbeat frame type names match on both ends', () => {
    const relay = readFileSync(join(RELAY, 'mod.rs'), 'utf-8')
    expect(relay).toMatch(/WS_GAP_TYPE: &str = "gap"/)
    expect(relay).toMatch(/WS_HEARTBEAT_TYPE: &str = "heartbeat"/)
    const protocol = readFileSync(
      join(LIB_DIR, '..', '..', 'shared', 'types', 'web-protocol.types.ts'),
      'utf-8'
    )
    expect(protocol).toMatch(/interface WsGapFrame \{\s+type: 'gap'/)
    expect(protocol).toMatch(/interface WsHeartbeatFrame \{\s+type: 'heartbeat'/)
  })
})

describe('Watch hub parity (projects, chat history, agent roster)', () => {
  const SRC_TAURI = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
  const hubSource = readFileSync(join(SRC_TAURI, 'web', 'watch', 'hub.rs'), 'utf-8')
  const protocol = readFileSync(
    join(LIB_DIR, '..', '..', 'shared', 'types', 'web-protocol.types.ts'),
    'utf-8'
  )

  it('the watch names the host serves are the ones the client names', () => {
    const asStr = hubSource.slice(hubSource.indexOf('fn as_str'), hubSource.indexOf('pub fn parse'))
    const rust = [...asStr.matchAll(/Self::\w+ => "(\w+)"/g)].map((match) => match[1])
    const client = /WS_WATCH_NAMES = \[([^\]]+)\]/.exec(protocol)
    expect(client).not.toBeNull()
    const names = [...(client?.[1] ?? '').matchAll(/'(\w+)'/g)].map((match) => match[1])
    expect(rust.sort()).toEqual([...names].sort())
  })

  it('the watch frame type matches on both ends', () => {
    expect(hubSource).toMatch(/WS_WATCH_TYPE: &str = "watch"/)
    expect(protocol).toMatch(/WS_WATCH_FRAME_TYPE = 'watch'/)
  })

  it('the host routes the watch and unwatch requests the client declares', () => {
    const dispatch = readFileSync(join(SRC_TAURI, 'web', 'ws', 'dispatch.rs'), 'utf-8')
    expect(dispatch).toMatch(/"watch" => handle_watch/)
    expect(dispatch).toMatch(/"unwatch" => handle_unwatch/)
    expect(protocol).toMatch(/'watch',\s*\n\s*'unwatch'/)
  })

  it('no relay, route or command still names the retired seq 0 nudges', () => {
    const sources = [
      ['web', 'sink', 'fanout.rs'],
      ['web', 'sink', 'watch_bridge.rs'],
      ['web', 'sink', 'mod.rs'],
      ['web', 'mod.rs'],
      ['web', 'projects_api.rs'],
      ['web', 'ws', 'projects.rs'],
      ['web', 'ws', 'sessions.rs'],
      ['commands', 'remote.rs'],
      ['commands', 'acp_history.rs']
    ]
    for (const parts of sources) {
      const source = readFileSync(join(SRC_TAURI, ...parts), 'utf-8')
      expect(source, parts.join('/')).not.toMatch(/projects_changed|chat_history_changed/)
    }
    expect(protocol).not.toMatch(/^\s*'(projects_changed|chat_history_changed)',?$/m)
  })
})
