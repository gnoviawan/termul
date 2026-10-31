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
import { WS_ERROR_CODES } from '@shared/types/web-protocol.types'
import { describe, expect, it } from 'vitest'
import { mapTauriVerdict } from '../acp-transport/tauri-verdicts'
import { AcpTransportError } from '../acp-transport/types'
import {
  claudeAccountSignedOutMessage,
  isClaudeAccountSignedOutError
} from '../agents/acp-spawn-errors'

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
      'revokeClaim',
      'listPreserved'
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
      const router = readFileSync(join(root, 'web', 'router', 'mod.rs'), 'utf-8')
      expect(tauri).toMatch(/acp_factory_key_status/)
      expect(tauri).toMatch(/acp_factory_key_save/)
      expect(router).toMatch(/\/acp\/factory-key/)
    })
  })

  describe('MCP OAuth unsafe-link parity (CAP-11)', () => {
    const RustRoot = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
    const readRust = (...parts: string[]): string => readFileSync(join(RustRoot, ...parts), 'utf-8')

    it('the Rust guard and the renderer facade agree on the code', () => {
      const rustCode = readRust('acp', 'safe_url.rs').match(
        /pub const MCP_UNSAFE_URL: &str = "([A-Z_]+)";/
      )?.[1]
      const tsCode = readFileSync(join(LIB_DIR, 'acp-api.ts'), 'utf-8').match(
        /export const MCP_UNSAFE_URL = '([A-Z_]+)'/
      )?.[1]
      expect(rustCode).toBe('MCP_UNSAFE_URL')
      expect(tsCode).toBe(rustCode)
    })

    it('both host transports check the sign-in link before it leaves the host', () => {
      const desktop = readRust('acp', 'commands.rs')
      const web = readRust('web', 'mcp_oauth_api.rs')
      expect(desktop).toMatch(/check_safe_url\(raw, Opener::Host\)/)
      expect(desktop).toMatch(/IpcResult::error\(refused\.to_string\(\), MCP_UNSAFE_URL\)/)
      expect(web).toMatch(/check_safe_url\(raw, Opener::Remote\)/)
      expect(web).toMatch(/McpOAuthError::UnsafeUrl\(_\) => MCP_UNSAFE_URL/)
    })

    it('a dedicated facade test covers both transports', () => {
      const content = readFileSync(join(LIB_DIR, 'acp-api-mcp-oauth.test.ts'), 'utf-8')
      expect(content).toMatch(/desktop: surfaces the host refusal as MCP_UNSAFE_URL/)
      expect(content).toMatch(/surfaces the host refusal as MCP_UNSAFE_URL and never navigates/)
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

  describe('Worktree parity (CAP — Web worktree parity)', () => {
    const Facade = join(LIB_DIR, 'worktree-api.ts')
    const WebAdapter = join(LIB_DIR, 'web-server-api.ts')
    const WebRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'web')
    const RouterRust = join(WebRust, 'router', 'mod.rs')
    const WorktreeApiRust = join(WebRust, 'worktree_api.rs')
    const WorktreeSymlinksRust = join(WebRust, 'worktree_api', 'symlinks.rs')
    const CommandsRust = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src', 'commands')

    const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    const WEB_OPS = [
      'list',
      'create',
      'remove',
      'branches',
      'check-dirty',
      'resolve-base-branch',
      'copy-include-files',
      'parse-gitignore',
      'create-symlinks',
      'ensure-symlinks'
    ].map((name) => ({
      route: `/worktree/${name}`,
      method: name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()),
      handler: name.replaceAll('-', '_'),
      command: `worktree_${name.replaceAll('-', '_')}`
    }))
    const OTHER_WEB_METHODS = ['renameBranch']

    const DESKTOP_ONLY_METHODS = [
      'removeAllManaged',
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

    it('web-server-api.ts exports webServerWorktree hitting every web route', () => {
      expect(existsSync(WebAdapter), 'web-server-api.ts should exist').toBe(true)
      const content = readFileSync(WebAdapter, 'utf-8')
      expect(content).toMatch(/export\s+const\s+\bwebServerWorktree\b/)
      for (const { route } of WEB_OPS) {
        expect(content, `web-server-api.ts should hit ${route}`).toMatch(
          new RegExp(escapeRe(route))
        )
      }
      // Network/parse failures must map to `NETWORK_ERROR`.
      expect(content).toMatch(/NETWORK_ERROR/)
    })

    it('facade branches every web method (invoke on Tauri, webServerWorktree on web)', () => {
      const content = readFileSync(Facade, 'utf-8')
      for (const { method } of WEB_OPS) {
        expect(content, `worktree-api.ts should branch ${method}`).toMatch(
          new RegExp(`webServerWorktree\\.${method}\\(`)
        )
      }
      const webRefs = (content.match(/webServerWorktree\./g) ?? []).length
      expect(webRefs).toBe(WEB_OPS.length + OTHER_WEB_METHODS.length)
    })

    it('facade keeps the desktop-only methods as WEB_UNSUPPORTED (no webServerWorktree ref)', () => {
      const content = readFileSync(Facade, 'utf-8')
      for (const method of DESKTOP_ONLY_METHODS) {
        expect(content, `worktree-api.ts should still define ${method}`).toMatch(
          new RegExp(`\\b${method}\\s*:`)
        )
        expect(content).not.toMatch(new RegExp(`webServerWorktree\\.${method}\\b`))
      }
    })

    it('router.rs registers every /worktree/* web route ahead of the static fallback', () => {
      expect(existsSync(RouterRust), 'router.rs should exist').toBe(true)
      const content = readFileSync(RouterRust, 'utf-8')
      for (const { route } of WEB_OPS) {
        expect(content, `router.rs should register ${route}`).toMatch(new RegExp(escapeRe(route)))
      }
    })

    it('worktree_api.rs and worktree_api/symlinks.rs define the Axum handlers', () => {
      expect(existsSync(WorktreeApiRust), 'worktree_api.rs should exist').toBe(true)
      const content = [WorktreeApiRust, WorktreeSymlinksRust]
        .map((file) => readFileSync(file, 'utf-8'))
        .join('\n')
      for (const { handler } of WEB_OPS) {
        expect(content, `the web worktree routes should define ${handler}`).toMatch(
          new RegExp(`pub async fn ${handler}\\b`)
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

    it('commands module defines the desktop Tauri command for every web route', () => {
      expect(existsSync(CommandsRust), 'commands module should exist').toBe(true)
      const content = readRustModule(CommandsRust)
      for (const { command: cmd } of WEB_OPS) {
        expect(content, `commands module should define ${cmd}`).toMatch(
          new RegExp(`\\b${escapeRe(cmd)}\\b`)
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
      expect(readLib('web-filename-search.ts')).toMatch(/files: data\.files/)
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
    const RouterRust = join(SrcTauri, 'web', 'router', 'mod.rs')
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
    const WebFileNameSearch = join(LIB_DIR, 'web-filename-search.ts')
    const WebAdapter = join(LIB_DIR, 'web-server-api.ts')
    const RouterRust = join(
      LIB_DIR,
      '..',
      '..',
      '..',
      'src-tauri',
      'src',
      'web',
      'router',
      'mod.rs'
    )
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
      expect(readFileSync(WebFileNameSearch, 'utf-8')).toMatch(/webServerSearch\.fileNames/)
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
      expect(content).toMatch(/collect_file_hits\(/)
      expect(content).toMatch(/assemble_final_batch\(/)
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
      expect(content).toMatch(/collect_file_hits\(/)
    })
  })

  describe('Media bytes parity (issue #1535)', () => {
    const Facade = join(LIB_DIR, 'media-bytes-api.ts')
    const SrcTauri = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
    const RouterRust = join(SrcTauri, 'web', 'router', 'mod.rs')
    const RawRouteRust = join(SrcTauri, 'web', 'fs_api', 'media_raw.rs')
    const CommandsRust = join(SrcTauri, 'commands', 'misc.rs')
    const LibRust = join(SrcTauri, 'lib.rs')

    it('media-bytes-api.ts branches on isTauriContext() between the command and /fs/raw', () => {
      const content = readFileSync(Facade, 'utf-8')
      expect(content).toMatch(/isTauriContext\(\)/)
      expect(content).toMatch(/invoke<ArrayBuffer>\('read_media_bytes'/)
      expect(content).toMatch(/\/fs\/raw\?path=/)
      expect(content).toMatch(/authHeader\(\)/)
      expect(content).toMatch(/boundedFsRequest\(/)
    })

    it('router registers /fs/raw in BOTH router variants', () => {
      const content = readFileSync(RouterRust, 'utf-8')
      const occurrences = (content.match(/"\/fs\/raw"/g) ?? []).length
      expect(occurrences, 'both router() and router_with_static() register the route').toBe(2)
    })

    it('both transports read through the shared media_bytes service', () => {
      const route = readFileSync(RawRouteRust, 'utf-8')
      expect(route).toMatch(/pub async fn raw\b/)
      expect(route).toMatch(/resolve_request_path\(/)
      expect(route).toMatch(/read_media\(/)
      expect(route).toMatch(/tracing::warn!/)
      const command = readFileSync(CommandsRust, 'utf-8')
      expect(command).toMatch(/pub async fn read_media_bytes\b/)
      expect(command).toMatch(/read_media\(/)
      expect(readFileSync(LibRust, 'utf-8')).toMatch(/commands::read_media_bytes\b/)
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

  // Canvas mode (figcraft embed): one facade over two transports (Tauri
  // commands `canvas_*` and `POST /canvas/*`, both backed by
  // `canvas::static_server::{open_canvas, close_canvas}` and
  // `canvas::persistence` through `canvas_mounts()`), the phone-width
  // shell gated by a typed UNSUPPORTED_SURFACE, and a renderer that never
  // branches on surface. The Rust suite covers the route behaviour.
  describe('Canvas parity (figcraft canvas mode)', () => {
    const TauriAdapter = join(LIB_DIR, 'tauri-canvas-api.ts')
    const WebAdapter = join(LIB_DIR, 'web-canvas-api.ts')
    const Facade = join(LIB_DIR, 'canvas-api.ts')
    const RustRoot = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
    const RENDERER = join(LIB_DIR, '..')

    /** Every facade method, its Tauri command and its web route. */
    const CANVAS_FACADE = {
      open: { command: 'canvas_open', route: '/canvas/open' },
      close: { command: 'canvas_close', route: '/canvas/close' },
      readDocument: { command: 'canvas_read_document', route: '/canvas/read-document' },
      documentLoaded: { command: 'canvas_document_loaded', route: '/canvas/document-loaded' },
      dirtyChanged: { command: 'canvas_dirty_changed', route: '/canvas/dirty-changed' },
      setVisible: { command: 'canvas_set_visible', route: '/canvas/set-visible' },
      writeSnapshot: { command: 'canvas_write_snapshot', route: '/canvas/write-snapshot' },
      diskChanged: { command: 'canvas_disk_changed', route: '/canvas/disk-changed' },
      resolveConflict: {
        command: 'canvas_resolve_conflict',
        route: '/canvas/resolve-conflict'
      },
      crashed: { command: 'canvas_crashed', route: '/canvas/crashed' }
    } as const

    it('the adapters exist and export the factory and the singleton', () => {
      expect(existsSync(TauriAdapter), 'tauri-canvas-api.ts should exist').toBe(true)
      expect(existsSync(WebAdapter), 'web-canvas-api.ts should exist').toBe(true)
      expect(
        fileContains('tauri-canvas-api.ts', /export\s+function\s+createTauriCanvasApi\b/)
      ).toBe(true)
      expect(fileContains('web-canvas-api.ts', /export\s+const\s+webCanvasApi\b/)).toBe(true)
      const api = readFileSync(join(LIB_DIR, 'api.ts'), 'utf-8')
      expect(api).toMatch(/export\s*\{[^}]*\bcanvasApi\b[^}]*\}/)
    })

    it('the facade picks the transport by isTauriContext() and gates phone width', () => {
      const content = readFileSync(Facade, 'utf-8')
      expect(content).toMatch(/isTauriContext\(\)/)
      expect(content).toMatch(/createTauriCanvasApi/)
      expect(content).toMatch(/webCanvasApi/)
      expect(content).toMatch(/isMobileWebShellViewport/)
      expect(content).toMatch(/UNSUPPORTED_SURFACE/)
    })

    it('every facade method exists on both transports, on both sides of the wire', () => {
      const types = readFileSync(
        join(LIB_DIR, '..', '..', 'shared', 'types', 'canvas.types.ts'),
        'utf-8'
      )
      const apiBody = types.match(/export interface CanvasApi \{([\s\S]*?)\n\}/)?.[1] ?? ''
      const declared = [...apiBody.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]).sort()
      expect(declared).toEqual(Object.keys(CANVAS_FACADE).sort())

      const tauri = readFileSync(TauriAdapter, 'utf-8')
      const web = readFileSync(WebAdapter, 'utf-8')
      const commands = readFileSync(join(RustRoot, 'commands', 'canvas.rs'), 'utf-8')
      const routes = readFileSync(join(RustRoot, 'web', 'canvas_api.rs'), 'utf-8')
      const persistenceRoutes = readFileSync(
        join(RustRoot, 'web', 'canvas_persistence_api.rs'),
        'utf-8'
      )
      const router = readFileSync(join(RustRoot, 'web', 'router', 'mod.rs'), 'utf-8')
      const bundlePath = readFileSync(join(RustRoot, 'canvas', 'bundle_path.rs'), 'utf-8')
      expect(router, 'the bearer gate exempts only bundle paths').toContain('is_bundle_path')
      const lib = readFileSync(join(RustRoot, 'lib.rs'), 'utf-8')
      for (const [method, { command, route }] of Object.entries(CANVAS_FACADE)) {
        expect(tauri, `tauri adapter ${method}`).toMatch(new RegExp(`\\b${method}\\s*\\(`))
        expect(web, `web adapter ${method}`).toMatch(new RegExp(`\\b${method}\\s*\\(`))
        expect(tauri, `tauri adapter invokes ${command}`).toContain(`'${command}'`)
        expect(web, `web adapter posts ${route}`).toContain(`'${route}'`)
        expect(commands, `Rust command ${command}`).toMatch(
          new RegExp(`pub async fn ${command}\\(`)
        )
        expect(lib, `${command} is registered`).toContain(`commands::${command},`)
        expect(routes + persistenceRoutes, `web route ${route}`).toMatch(
          new RegExp(`\\.route\\(\\s*"${route}"`)
        )
        expect(bundlePath, `${route} stays behind the bearer gate`).toContain(
          `"${route.slice('/canvas/'.length)}"`
        )
      }
      expect(routes).toContain('.merge(crate::web::canvas_persistence_api::persistence_routes())')
      for (const rust of [commands, persistenceRoutes]) {
        expect(rust).toContain('canvas_mounts()')
      }
      for (const rust of [commands, routes]) {
        expect(rust).toMatch(/open_canvas\(/)
        expect(rust).toMatch(/close_canvas\(/)
        expect(rust, 'one doc-path check against the opening project root').toMatch(
          /resolve_doc_path\(&(\w+\.)?doc_path, &(\w+\.)?project_id, /
        )
      }
    })

    it('agent calls reach the lease holder through one gateway client on both transports', () => {
      const ws = readFileSync(join(LIB_DIR, 'acp-transport', 'ws-transport.ts'), 'utf-8')
      expect(ws).toMatch(/readonly canvas = new CanvasGatewayClient\(/)
      expect(ws).toMatch(/this\.canvas\.handleFrame\(/)
      expect(ws).toMatch(/this\.canvas\.handleLeaseLost\(/)
      expect(ws, 're-reports its mounts on every (re)connect').toMatch(
        /this\.canvas\.onConnected\(\)/
      )
      const desktop = readFileSync(join(LIB_DIR, 'acp-transport', 'desktop-transport.ts'), 'utf-8')
      expect(desktop).toMatch(/class DesktopAcpTransport extends WsAcpTransport\b/)
      expect(desktop).toMatch(/WebSocketImpl: ChannelSocket\b/)
      const harness = readFileSync(
        join(RustRoot, 'web', 'ws', 'harness', 'canvas_gateway_tests.rs'),
        'utf-8'
      )
      for (const body of [
        'a_gateway_call_reaches_the_holder_and_its_reply_answers_the_agent',
        'a_holder_back_within_the_grace_takes_its_calls_again',
        'a_holder_gone_past_the_grace_leaves_calls_closed',
        'a_call_the_holder_never_answers_times_out'
      ]) {
        expect(harness, body).toContain(`on_both_carriers!(${body});`)
      }
    })

    it('shared contracts carry the open info, the facade and both typed error sets', () => {
      const content = readFileSync(
        join(LIB_DIR, '..', '..', 'shared', 'types', 'canvas.types.ts'),
        'utf-8'
      )
      expect(content).toMatch(/export\s+interface\s+CanvasOpenInfo\b/)
      expect(content).toMatch(/export\s+interface\s+CanvasApi\b/)
      expect(content).toMatch(/export\s+const\s+CanvasErrorCodes\b/)
      expect(content).toMatch(/UNSUPPORTED_SURFACE/)
      expect(content).toMatch(/export\s+const\s+CANVAS_BRIDGE_ERROR_CODES\b/)
    })

    it('the renderer never branches on surface below the facade', () => {
      for (const file of [
        join(LIB_DIR, 'canvas-bridge.ts'),
        join(LIB_DIR, 'canvas-theme.ts'),
        join(RENDERER, 'stores', 'canvas-store.ts'),
        join(RENDERER, 'components', 'canvas', 'CanvasPanel.tsx'),
        join(RENDERER, 'components', 'canvas', 'CanvasShell.tsx')
      ]) {
        expect(readFileSync(file, 'utf-8'), file).not.toMatch(/isTauriContext|__TAURI/)
      }
    })

    it('renderer wiring: store + panel + shell + tab chrome + dispatch + close routing', () => {
      expect(readFileSync(join(RENDERER, 'stores', 'canvas-store.ts'), 'utf-8')).toMatch(
        /canvasApi/
      )
      // AD-19: the iframe lives in the mount layer both shells render, not in
      // the tab; the panel only claims the slot it is laid over.
      expect(
        readFileSync(join(RENDERER, 'components', 'canvas', 'CanvasPanel.tsx'), 'utf-8')
      ).toMatch(/claimSlot/)
      expect(
        readFileSync(join(RENDERER, 'components', 'canvas', 'CanvasMountLayer.tsx'), 'utf-8')
      ).toMatch(/CanvasShell/)
      const layout = readFileSync(join(RENDERER, 'layouts', 'WorkspaceLayout.tsx'), 'utf-8')
      // Both shells and the mid-session token screen keep the layer.
      expect(layout.match(/<CanvasMountLayer /g)?.length).toBe(3)
      expect(
        readFileSync(join(RENDERER, 'components', 'canvas', 'CanvasShell.tsx'), 'utf-8')
      ).toMatch(/createCanvasBridge/)

      const tab = join(RENDERER, 'components', 'workspace', 'tabs', 'canvas-tab.tsx')
      expect(readFileSync(tab, 'utf-8')).toMatch(/dirty/)
      const chrome = join(RENDERER, 'components', 'workspace', 'tabs', 'tab-chrome.tsx')
      expect(readFileSync(chrome, 'utf-8')).toMatch(/bg-foreground\/70/)

      const paneContent = join(RENDERER, 'components', 'workspace', 'PaneContent.tsx')
      expect(readFileSync(paneContent, 'utf-8')).toMatch(/CanvasPanel/)
      const tabBar = join(RENDERER, 'components', 'workspace', 'WorkspaceTabBar.tsx')
      expect(readFileSync(tabBar, 'utf-8')).toMatch(/closeWorkspaceTab/)
      // Closing the tab hides the canvas; only project close and quit unmount
      // it, through the host's AD-31 sequence.
      expect(readFileSync(join(LIB_DIR, 'workspace-tab-close.ts'), 'utf-8')).toMatch(
        /canvas: removeTab/
      )
      expect(readFileSync(join(RENDERER, 'stores', 'project-store.ts'), 'utf-8')).toMatch(
        /unmountCanvasesFor\(\[id\]\)/
      )
      expect(
        readFileSync(join(RENDERER, 'layouts', 'workspace-layout', 'use-app-close.ts'), 'utf-8')
      ).toMatch(/unmountCanvases\(\)/)
      expect(readFileSync(join(LIB_DIR, 'tauri-canvas-api.ts'), 'utf-8')).toContain(
        'IPC_COMMANDS.CLOSE, { projectId, mountSeq, discard }'
      )
      expect(readFileSync(join(LIB_DIR, 'web-canvas-api.ts'), 'utf-8')).toContain(
        "'/canvas/close', { projectId, mountSeq, discard }"
      )
      const tree = join(RENDERER, 'stores', 'workspace-store', 'tree.ts')
      expect(readFileSync(tree, 'utf-8')).toMatch(/export function canvasTabId/)
      const index = join(RENDERER, 'stores', 'workspace-store', 'index.ts')
      expect(readFileSync(index, 'utf-8')).toMatch(/canvasTabId/)
    })
  })

  describe('session RPC parity', () => {
    it('parity checklist names both adapters', () => {
      for (const adapter of ['tauri-terminal-api.ts', 'web-terminal-api.ts']) {
        const content = readFileSync(join(LIB_DIR, adapter), 'utf-8')
        for (const method of ['submitCommand', 'requestCompletion', 'cancelCompletion']) {
          expect(content, `${adapter} should expose ${method}`).toMatch(
            new RegExp(`\\b${method}\\s*(?::|\\()`)
          )
        }
      }

      const transport = readFileSync(join(LIB_DIR, 'command-editor-transport.ts'), 'utf-8')
      for (const rpc of [
        'command_editor_submit',
        'command_editor_request_completion',
        'command_editor_cancel_completion',
        'command_editor_restore_prompt'
      ]) {
        expect(transport).toContain(`'${rpc}'`)
      }
      expect(transport).not.toContain('terminal_write')
    })

    it('restorePrompt parity', () => {
      for (const adapter of ['tauri-terminal-api.ts', 'web-terminal-api.ts']) {
        expect(
          fileContains(adapter, /\brestorePrompt\s*(?::|\()/),
          `${adapter} should expose restorePrompt`
        ).toBe(true)
      }

      const transport = readFileSync(join(LIB_DIR, 'command-editor-transport.ts'), 'utf-8')
      expect(transport).toContain("'command_editor_restore_prompt'")
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
    const WebFsWatch = join(LIB_DIR, 'web-fs-watch.ts')
    expect(existsSync(WebFsWatch), 'web-fs-watch.ts should exist').toBe(true)
    expect(readFileSync(FsFacade, 'utf-8')).toMatch(/watchWebDirectory\(dirPath\)/)
    const content = readFileSync(WebFsWatch, 'utf-8')
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
  const RouterRust = join(SRC_TAURI, 'web', 'router', 'mod.rs')
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
  const RouterRust = join(SRC_TAURI, 'web', 'router', 'mod.rs')
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

describe('Shared chat read marker parity (cross-surface unread)', () => {
  const SRC_TAURI = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
  const protocol = readFileSync(
    join(LIB_DIR, '..', '..', 'shared', 'types', 'web-protocol.types.ts'),
    'utf-8'
  )

  it('one host service owns the marker and the relay serves it to every carrier', () => {
    const service = readFileSync(join(SRC_TAURI, 'web', 'chat_reads.rs'), 'utf-8')
    expect(service).toMatch(
      /pub fn mark\(\s*&self,\s*session_id: &str,\s*head: &LogHead,\s*log_epoch: Option<&str>,\s*seq: u64,?\s*\)/
    )
    const dispatch = readFileSync(join(SRC_TAURI, 'web', 'ws', 'dispatch.rs'), 'utf-8')
    expect(dispatch).toMatch(/"mark_chat_read" => handle_mark_chat_read/)
    const sources = readFileSync(join(SRC_TAURI, 'web', 'watch', 'sources.rs'), 'utf-8')
    expect(sources).toMatch(/WatchKind::ChatReads/)
  })

  it('the protocol declares the request, its class and the watch payloads', () => {
    expect(protocol).toMatch(/'mark_chat_read',/)
    expect(protocol).toMatch(/mark_chat_read: \['idempotent', null\]/)
    expect(protocol).toMatch(/interface ChatReadsWatchState/)
  })

  it('the transport facade and the shell tracker carry it on both renderer roots', () => {
    const transport = readTsModule(join(LIB_DIR, 'acp-transport'))
    expect(transport).toMatch(
      /markChatRead\(\s*sessionId: SessionId,\s*seq: number,\s*logEpoch: string \| null\s*\)/
    )
    expect(transport).toMatch(/'mark_chat_read'/)
    const shell = readFileSync(join(LIB_DIR, '..', 'hooks', 'use-shell-unread-tracker.ts'), 'utf-8')
    expect(shell).toMatch(/startChatReadSync\(\)/)
    expect(shell).toMatch(/useChatReadMarker\(activeSessionIds\)/)
    const layout = readFileSync(join(LIB_DIR, '..', 'layouts', 'WorkspaceLayout.tsx'), 'utf-8')
    expect(layout).toMatch(/useShellUnreadTracker\(\)/)
  })
})

describe('Window ACL parity (issue #1443)', () => {
  // The renderer's close handler prevents the WM close and calls
  // window.hide() on macOS/Linux. When default.json lacks
  // core:window:allow-hide the ACL denies the call and the window can
  // neither close nor hide — this regression pinned that dead-end state.
  const CAPABILITIES = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'capabilities', 'default.json')
  /** Static window-method → ACL permission map (core:window commands). */
  const PERMISSION_BY_METHOD: Record<string, string> = {
    hide: 'core:window:allow-hide',
    show: 'core:window:allow-show',
    unminimize: 'core:window:allow-unminimize',
    setFocus: 'core:window:allow-set-focus',
    minimize: 'core:window:allow-minimize',
    maximize: 'core:window:allow-maximize',
    unmaximize: 'core:window:allow-unmaximize',
    toggleMaximize: 'core:window:allow-toggle-maximize',
    close: 'core:window:allow-close',
    destroy: 'core:window:allow-destroy',
    startDragging: 'core:window:allow-start-dragging',
    startResizeDragging: 'core:window:allow-start-resize-dragging',
    setPosition: 'core:window:allow-set-position',
    setSize: 'core:window:allow-set-size'
  }

  const grantedPermissions = (): Set<string> => {
    const capabilities = JSON.parse(readFileSync(CAPABILITIES, 'utf-8')) as {
      permissions: Array<string | { identifier: string }>
    }
    return new Set(
      capabilities.permissions.map((entry) =>
        typeof entry === 'string' ? entry : entry.identifier
      )
    )
  }

  it('every JS-invoked core:window command in the renderer is ACL-granted', () => {
    const granted = grantedPermissions()
    // Calls read off the thin tauri-window facade (the Story 1.6 Biome ban
    // keeps every import of @tauri-apps/api/window routed through it) plus
    // the one direct call in TauriApp.tsx.
    const rendererSources = [
      ...readdirSync(LIB_DIR)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => readFileSync(join(LIB_DIR, f), 'utf-8')),
      ...readdirSync(join(LIB_DIR, '..'))
        .filter((f) => f.endsWith('.tsx'))
        .map((f) => readFileSync(join(LIB_DIR, '..', f), 'utf-8'))
    ]
    const sources = rendererSources.join('\n')
    for (const [method, permission] of Object.entries(PERMISSION_BY_METHOD)) {
      if (!new RegExp(`\\.\\s*${method}\\s*\\(`).test(sources)) continue
      expect(
        granted.has(permission),
        `renderer calls .${method}() but capability is missing: ${permission}`
      ).toBe(true)
    }
  })

  it('the close-to-tray path is explicitly granted (preventDefault already fired)', () => {
    const granted = grantedPermissions()
    expect(granted.has('core:window:allow-hide')).toBe(true)
    expect(granted.has('core:window:allow-show')).toBe(true)
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

describe('Claude Accounts parity (ADR-0004)', () => {
  const SRC_TAURI = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
  const read = (...parts: string[]): string => readFileSync(join(SRC_TAURI, ...parts), 'utf-8')
  const desktopTransport = readFileSync(
    join(LIB_DIR, 'acp-transport', 'desktop-transport.ts'),
    'utf-8'
  )
  const wsTransport = readFileSync(join(LIB_DIR, 'acp-transport', 'ws-transport.ts'), 'utf-8')
  const facade = readFileSync(join(LIB_DIR, 'claude-accounts-api.ts'), 'utf-8')

  it('desktop and web reach the same list/default/project operations', () => {
    // Desktop speaks /ws over the Tauri Channel carrier, so it inherits these.
    expect(desktopTransport).toMatch(/class DesktopAcpTransport extends WsAcpTransport/)
    expect(desktopTransport).not.toMatch(/ClaudeAccount|ClaudeUsage/)
    const dispatch = read('web', 'ws', 'dispatch.rs')
    for (const request of [
      'list_claude_accounts',
      'list_claude_usage',
      'set_default_claude_account',
      'set_project_claude_account',
      'set_claude_auto_switch'
    ]) {
      expect(wsTransport).toContain(`'${request}'`)
      expect(dispatch).toContain(`"${request}" => handle_${request}`)
    }
  })

  it('the automatic-switching setter and the project compare-and-set exist on both carriers', () => {
    // The web client may turn automatic switching on or off, like it may
    // choose the Default Account. The invoke carrier mirrors the /ws handlers.
    const tauri = read('acp', 'commands', 'claude_accounts.rs')
    const ws = read('web', 'ws', 'claude_accounts.rs')
    expect(read('lib.rs')).toContain('acp::commands::claude_accounts_set_auto_switch')
    expect(tauri).toMatch(/fn claude_accounts_set_auto_switch\([^)]*enabled: bool/s)
    expect(ws).toMatch(/set_auto_switch\(parsed\.enabled\)/)
    for (const source of [tauri, ws]) {
      expect(source).toMatch(/expected_account_id/)
    }
    expect(facade).not.toMatch(/desktopOnly\('setAutoSwitch'/)
    expect(wsTransport).toMatch(/\.\.\.\(expectedAccountId \? \{ expectedAccountId \} : \{\}\)/)
  })

  it('add, rename, remove, the link sign-in and cancel reach the same /ws handlers on every surface', () => {
    // Desktop inherits these from WsAcpTransport; no Tauri command duplicates them.
    const dispatch = read('web', 'ws', 'dispatch.rs')
    const lib = read('lib.rs')
    for (const request of [
      'add_claude_account',
      'rename_claude_account',
      'remove_claude_account',
      'start_claude_link_login',
      'finish_claude_link_login',
      'cancel_claude_login'
    ]) {
      expect(wsTransport).toContain(`'${request}'`)
      expect(dispatch).toContain(`"${request}" => handle_${request}(id, &req.payload, acp).await`)
    }
    for (const retired of [
      'claude_accounts_add',
      'claude_accounts_login_cancel',
      'claude_accounts_rename',
      'claude_accounts_remove'
    ]) {
      expect(lib).not.toContain(`acp::commands::${retired}`)
      expect(facade).not.toContain(`'${retired}'`)
    }
    expect(facade).not.toMatch(
      /desktopOnly\('(add|rename|remove|startLinkLogin|finishLinkLogin|cancelLogin)'/
    )
    // The link sign-in shares the browser login's per-Account registry, so a
    // cancel from either surface stops whichever sign-in is running.
    expect(read('acp', 'claude_agent', 'accounts.rs')).toMatch(/self\.logins\.stop\(id\)/)
  })

  it('the browser login stays desktop-only and gated in the facade', () => {
    const dispatch = read('web', 'ws', 'dispatch.rs')
    expect(facade).toContain(`'claude_accounts_login'`)
    expect(read('lib.rs')).toContain('acp::commands::claude_accounts_login')
    expect(dispatch).not.toMatch(/"login_claude_account"/)
    expect(facade).toMatch(/if \(!isTauriContext\(\)\) return Promise\.reject/)
    expect(facade).toMatch(
      /signInFlow: \(\): ClaudeSignInFlow => \(isTauriContext\(\) \? 'browser' : 'link'\)/
    )
  })

  it('the spawn sends the projectId that selects the account on every carrier', () => {
    // Desktop and the browser share the /ws spawn_agent handler. The host
    // command file no longer has a per-domain spawn command.
    expect(wsTransport).toMatch(/'spawn_agent',\s*\{ config, projectId: projectId \?\? null \}/)
    expect(read('web', 'ws', 'agents.rs')).toMatch(/project_id: Option<String>/)
    expect(read('acp', 'manager', 'mod.rs')).toMatch(/project_id: Option<String>/)
  })

  it('every UI carrier checks the sign-in before it stores a choice; headless setup does not', () => {
    // #1392: the ws handlers serve desktop and the browser; the Tauri commands
    // are the desktop invoke carrier. Both refuse a signed-out Account. The
    // `termul-server claude account` CLI may assign before `login`.
    const ws = read('web', 'ws', 'claude_accounts.rs')
    const tauri = read('acp', 'commands', 'claude_accounts.rs')
    for (const source of [ws, tauri]) {
      expect(source).toMatch(/set_default_account\([^;]*SignInCheck::Required\)/s)
      expect(source).toMatch(/set_project_account\([^;]*SignInCheck::Required,?\s*\)/s)
    }
    expect(read('acp', 'claude_admin.rs')).not.toContain('SignInCheck::Required')
    const dispatch = read('web', 'ws', 'dispatch.rs')
    expect(dispatch).toContain('handle_set_default_claude_account(id, &req.payload, acp).await')
    expect(dispatch).toContain('handle_set_project_claude_account(id, &req.payload, acp).await')
  })

  it('a signed-out refusal reads the same on the /ws code and the desktop invoke prefix', () => {
    const reason = 'The Claude account "Work" is not signed in.'
    const viaWs = new AcpTransportError(WS_ERROR_CODES.CLAUDE_ACCOUNT_SIGNED_OUT, reason)
    const viaInvoke = mapTauriVerdict(`ACP_CLAUDE_ACCOUNT_SIGNED_OUT: ${reason}`)
    expect(viaInvoke).toEqual(viaWs)
    for (const error of [viaWs, viaInvoke, `ACP_CLAUDE_ACCOUNT_SIGNED_OUT: ${reason}`]) {
      expect(isClaudeAccountSignedOutError(error)).toBe(true)
      expect(claudeAccountSignedOutMessage(error)).toBe(reason)
    }
    expect(isClaudeAccountSignedOutError(new Error(reason))).toBe(false)
  })
})

// Git History commit detail + commit file diff (main-panel Git History tab).
// Source-grep checks pin that one shared Rust function backs each Tauri command
// AND its web read route, and that the renderer facade reaches both.
describe('Git History commit detail parity', () => {
  const SRC_TAURI = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
  const GitApiFacade = join(LIB_DIR, 'git-api.ts')
  const WebAdapter = join(LIB_DIR, 'web-server-api.ts')
  const RouterRust = join(SRC_TAURI, 'web', 'router', 'mod.rs')
  const RouteRust = join(SRC_TAURI, 'web', 'git_history_api.rs')
  const ServiceRust = join(SRC_TAURI, 'trackers', 'git_tracker', 'commit_detail.rs')
  const CommandsGitRust = join(SRC_TAURI, 'commands', 'git.rs')
  const LibRust = join(SRC_TAURI, 'lib.rs')

  const OPS = [
    {
      method: 'getCommitDetail',
      command: 'git_get_commit_detail',
      route: '/git/commit-detail',
      handler: 'get_commit_detail',
      payload: 'GitCommitDetail'
    },
    {
      method: 'getCommitFileDiff',
      command: 'git_get_commit_file_diff',
      route: '/git/commit-file-diff',
      handler: 'get_commit_file_diff',
      payload: 'GitCommitFileDiff'
    }
  ] as const

  for (const op of OPS) {
    it(`git-api.ts branches ${op.method} on isTauriContext() between invoke and webServerGit`, () => {
      const content = readFileSync(GitApiFacade, 'utf-8')
      expect(content).toMatch(new RegExp(`${op.method}: async`))
      expect(content).toMatch(new RegExp(`invokeIpc<\\w+>\\('${op.command}'`))
      expect(content).toMatch(new RegExp(`webServerGit\\.${op.method}\\(`))
    })

    it(`web-server-api.ts exposes webServerGit.${op.method} hitting ${op.route}`, () => {
      const content = readFileSync(WebAdapter, 'utf-8')
      expect(content).toMatch(new RegExp(`async ${op.method}\\(`))
      expect(content).toContain(`'${op.route}'`)
    })

    it(`router.rs registers ${op.route} in BOTH router variants`, () => {
      const content = readFileSync(RouterRust, 'utf-8')
      const occurrences = content.split(`"${op.route}"`).length - 1
      expect(occurrences, 'both router() and router_with_static() register the route').toBe(2)
    })

    it(`git_history_api.rs ${op.handler} is a READ route through resolve_cwd and the shared service`, () => {
      const content = readFileSync(RouteRust, 'utf-8')
      expect(content).toMatch(new RegExp(`pub async fn ${op.handler}`))
      expect(content).toContain(`resolve_cwd::<${op.payload}>(&req.cwd, &state, None, false)`)
      expect(content).toMatch(new RegExp(`git_tracker::${op.command}`))
    })

    it(`the Tauri command ${op.command} is defined and registered over the shared service`, () => {
      const command = readFileSync(CommandsGitRust, 'utf-8')
      expect(command).toMatch(new RegExp(`pub async fn ${op.command}`))
      expect(command).toMatch(new RegExp(`git_tracker::${op.command}`))
      expect(readFileSync(LibRust, 'utf-8')).toContain(`commands::${op.command},`)
      expect(readFileSync(ServiceRust, 'utf-8')).toMatch(new RegExp(`pub fn ${op.command}`))
    })
  }

  it('git_history_api.rs logs through tracing and runs git off the async runtime', () => {
    const content = readFileSync(RouteRust, 'utf-8')
    expect(content).toMatch(/IpcBody/)
    expect(content).toMatch(/spawn_blocking/)
    expect(content).toMatch(/tracing::/)
  })
})

describe('Browser policy parity', () => {
  const SRC_TAURI = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
  const Facade = join(LIB_DIR, 'browser-policy-api.ts')
  const RouterRust = join(SRC_TAURI, 'web', 'router', 'mod.rs')
  const RouteRust = join(SRC_TAURI, 'web', 'browser_policy_api.rs')
  const CommandsRust = join(SRC_TAURI, 'commands', 'browser_policy.rs')
  const LibRust = join(SRC_TAURI, 'lib.rs')
  const WireRust = join(SRC_TAURI, 'acp', 'browser_policy', 'wire.rs')
  const ServiceRust = join(SRC_TAURI, 'acp', 'browser_policy', 'service.rs')
  const SourcesRust = join(SRC_TAURI, 'web', 'watch', 'sources.rs')
  const ContractTs = join(LIB_DIR, '..', '..', 'shared', 'types', 'browser-policy.types.ts')

  const OPERATIONS = [
    {
      method: 'getProject',
      command: 'browser_policy_get_project',
      route: '/host/browser-policy/project',
      service: 'project_view'
    },
    {
      method: 'getApp',
      command: 'browser_policy_get_app',
      route: '/host/browser-policy/app',
      service: 'app_view'
    },
    {
      method: 'applyProject',
      command: 'browser_policy_apply_project',
      route: '/host/browser-policy/project',
      service: 'apply_project'
    },
    {
      method: 'applyApp',
      command: 'browser_policy_apply_app',
      route: '/host/browser-policy/app',
      service: 'apply_app'
    }
  ] as const

  for (const op of OPERATIONS) {
    it(`${op.method} goes through ${op.command} on desktop and ${op.route} on web`, () => {
      const facade = readFileSync(Facade, 'utf-8')
      expect(facade).toContain(`${op.method}:`)
      expect(facade).toContain(`'${op.command}'`)
      expect(facade).toContain('POLICY_BASE')
      expect(facade).toMatch(/isTauriContext\(\) \? desktopBrowserPolicyApi : webBrowserPolicyApi/)
      expect(readFileSync(RouteRust, 'utf-8')).toContain(`"${op.route}"`)
    })

    it(`${op.command} is defined, registered in lib.rs and calls the shared service (${op.service})`, () => {
      const commands = readFileSync(CommandsRust, 'utf-8')
      expect(commands).toContain(`pub async fn ${op.command}(`)
      expect(commands).toContain(`.${op.service}(`)
      expect(readFileSync(LibRust, 'utf-8')).toContain(`commands::${op.command},`)
    })

    it(`the ${op.route} route calls the same shared service method (${op.service})`, () => {
      expect(readFileSync(RouteRust, 'utf-8')).toContain(`.${op.service}(`)
    })
  }

  it('router.rs merges the policy router in BOTH router variants', () => {
    const content = readFileSync(RouterRust, 'utf-8')
    const occurrences = content.split('browser_policy_router(').length - 1
    expect(occurrences, 'both router() and router_with_static() merge it').toBe(2)
  })

  it('every policy route sits under a bearer-gated prefix', () => {
    const gate = readFileSync(join(SRC_TAURI, 'web', 'router', 'gate.rs'), 'utf-8')
    expect(gate).toMatch(/const GATED_PREFIXES[^;]*"\/host\/"/s)
    for (const route of new Set(OPERATIONS.map((op) => op.route))) {
      expect(route.startsWith('/host/')).toBe(true)
    }
  })

  it('commands run only from the main webview', () => {
    const commands = readFileSync(CommandsRust, 'utf-8')
    expect(commands).toMatch(/webview\.label\(\) != "main"/)
  })

  it('the TypeScript operations and the Rust wire operations are the same set', () => {
    const rust = readFileSync(WireRust, 'utf-8')
    const ts = readFileSync(ContractTs, 'utf-8')
    const variants: Record<string, string> = {
      add_origin: 'AddOrigin',
      remove_origin: 'RemoveOrigin',
      add_preapproval: 'AddPreapproval',
      remove_preapproval: 'RemovePreapproval',
      set_ephemeral: 'SetEphemeral',
      set_global_profile: 'SetGlobalProfile',
      set_ask_before_password_submit: 'SetAskBeforePasswordSubmit',
      clear_global_profile: 'ClearGlobalProfile'
    }
    for (const [name, variant] of Object.entries(variants)) {
      expect(ts, name).toContain(`op: '${name}'`)
      expect(rust, name).toContain(variant)
    }
    const tsOps = new Set([...ts.matchAll(/op: '([a-z_]+)'/g)].map((m) => m[1]))
    expect(tsOps).toEqual(new Set(Object.keys(variants)))
  })

  it('change events reach every client: fanned out by the service, carried by the agents watch, routed by the roster watch', () => {
    expect(readFileSync(ServiceRust, 'utf-8')).toContain('"acp:browser_policy_changed"')
    expect(readFileSync(SourcesRust, 'utf-8')).toMatch(
      /AGENT_TRANSIENT_EVENTS[^;]*"browser_policy_changed"/s
    )
    const roster = readFileSync(
      join(LIB_DIR, '..', 'stores', 'acp-store', 'agent-roster-watch.ts'),
      'utf-8'
    )
    expect(roster).toContain("'browser_policy_changed'")
    expect(roster).toContain('publishBrowserPolicyChange')
  })

  it('the settings section is registered and the facade logs through log-api', () => {
    const categories = readFileSync(
      join(LIB_DIR, '..', 'pages', 'app-preferences', 'categories.tsx'),
      'utf-8'
    )
    expect(categories).toContain("id: 'browser'")
    expect(readFileSync(Facade, 'utf-8')).toContain("from './log-api'")
  })
})

// Browser consent tickets and Stop: the desktop answers through its
// `main`-webview commands, a remote client through `/ws`, and the facade
// picks the carrier. Source-grep checks pin that every carrier exists.
describe('Browser consent and Stop parity', () => {
  const SRC_TAURI = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
  const read = (...parts: string[]): string => readFileSync(join(SRC_TAURI, ...parts), 'utf-8')
  const facade = readFileSync(join(LIB_DIR, 'browser-consent-api.ts'), 'utf-8')

  it('the facade branches on isTauriContext() between the commands and the transport', () => {
    expect(facade).toMatch(/invokeIpc<null>\('browser_ticket_respond'/)
    expect(facade).toMatch(/invokeIpc<null>\('browser_stop'/)
    expect(facade).toMatch(/getAcpTransport\(\)\.respondPermission\(/)
    expect(facade).toMatch(/getAcpTransport\(\)\.stopBrowserAgent\(/)
    expect(readFileSync(join(LIB_DIR, 'acp-transport', 'ws-transport.ts'), 'utf-8')).toMatch(
      /this\.request\('browser_stop', \{ sessionId \}\)/
    )
  })

  it('registers both desktop commands and routes both /ws requests to the host paths', () => {
    const lib = read('lib.rs')
    expect(lib).toContain('commands::browser_ticket_respond,')
    expect(lib).toContain('commands::browser_stop,')
    const dispatch = read('web', 'ws', 'dispatch.rs')
    expect(dispatch).toMatch(/handle_respond_host_ticket\(id, &req\.payload, env\)/)
    expect(dispatch).toMatch(/"browser_stop" => handle_browser_stop\(id, &req\.payload, env\)/)
  })

  it('both carriers resolve through the same host ticket table and stop latch', () => {
    expect(read('commands', 'browser.rs')).toMatch(/tickets\.answer\(Approver::Desktop/)
    expect(read('web', 'permissions.rs')).toMatch(/\.answer\(approver, request_id, option_id\)/)
    expect(read('commands', 'browser.rs')).toMatch(
      /browser_automation::stop_session\(&session_id\)/
    )
    expect(read('web', 'ws', 'subscribe.rs')).toMatch(
      /browser_automation::stop_session\(&parsed\.session_id\)/
    )
  })
})

// spec-bug-report-dialog: bug-report facade parity. One renderer facade ships
// the diagnostics collect + `gh` submit on BOTH transports — the Tauri
// commands `collect_bug_report_context` / `submit_bug_report` (desktop) and
// the `/log/*` HTTP routes (web/remote + termul-server; the `/log/` prefix
// inherits the server's GATED_PREFIXES bearer auth). The Rust-side wiring
// (commands module, invoke_handler, router.rs, the route handlers) is pinned
// by the Rust test suite — this block pins the renderer-side contract.
describe('Bug report parity (spec-bug-report-dialog)', () => {
  const Facade = join(LIB_DIR, 'bug-report-api.ts')
  const SharedTypes = join(LIB_DIR, '..', '..', 'shared', 'types', 'bug-report.types.ts')

  it('bug-report-api.ts exists, exports bugReportApi, and branches on isTauriContext()', () => {
    expect(existsSync(Facade), 'bug-report-api.ts should exist').toBe(true)
    const content = readFileSync(Facade, 'utf-8')
    expect(content).toMatch(/export\s+const\s+\bbugReportApi\b/)
    expect(content).toMatch(/isTauriContext\(\)/)
    for (const method of ['collectBugReportContext', 'submitBugReport']) {
      expect(content, `bug-report-api.ts should implement ${method}`).toMatch(
        new RegExp(`\\b${method}\\s*\\(`)
      )
    }
  })

  it('the facade reaches both transports with the pinned op and route names', () => {
    const content = readFileSync(Facade, 'utf-8')
    // Desktop: IpcResult-returning Tauri commands (the IpcResult convention,
    // so invokeIpc — not invokeIpcWrapped).
    expect(content).toMatch(/invokeIpc<\s*BugReportContext\s*>\('collect_bug_report_context'/)
    expect(content).toMatch(/invokeIpc<\s*BugReportSubmitResult\s*>\('submit_bug_report'/)
    // Web: the /log/* POST routes via postJson (IpcBody replies).
    expect(content).toMatch(/postJson<\s*BugReportContext\s*>\('\/log\/diagnostics'/)
    expect(content).toMatch(/postJson<\s*BugReportSubmitResult\s*>\('\/log\/report-bug'/)
  })

  it('api.ts exports the bugReportApi singleton', () => {
    const content = readFileSync(join(LIB_DIR, 'api.ts'), 'utf-8')
    expect(content).toMatch(/export\s*\{[^}]*\bbugReportApi\b[^}]*\}/)
  })

  it('shared types file carries the wire contract', () => {
    expect(existsSync(SharedTypes), 'bug-report.types.ts should exist').toBe(true)
    const content = readFileSync(SharedTypes, 'utf-8')
    expect(content).toMatch(/export\s+interface\s+BugReportContext\b/)
    expect(content).toMatch(/export\s+interface\s+BugReportSubmitRequest\b/)
    expect(content).toMatch(/export\s+type\s+BugReportSubmitResult\b/)
  })

  it('the fallback helpers exist; the URL builder never emits a labels param', () => {
    const content = readFileSync(Facade, 'utf-8')
    expect(content).toMatch(/export\s+function\s+\bbuildIssueUrl\b/)
    expect(content).toMatch(/export\s+function\s+\bbuildIssueMarkdown\b/)
    expect(content).toMatch(/export\s+async\s+function\s+\bcopyBugReportToClipboard\b/)
    // The clipboard copy reuses the canonical copyText helper (Tauri plugin,
    // secure-context Async Clipboard API, then the textarea fallback), never
    // a bare navigator.clipboard.writeText call.
    expect(content).toMatch(/copyText\(/)
    expect(content).not.toMatch(/\bnavigator\.clipboard\b/)
    // No labels param — issue creation without triage permission can 404.
    expect(content).not.toMatch(/labels=/)
    // Boundary/failure logging for collect/submit exists (report contents are
    // never logged — asserted behaviorally in bug-report-api.test.ts).
    expect(content).toMatch(/logFrontendError/)
  })

  it('a dedicated facade test exists', () => {
    expect(
      existsSync(join(LIB_DIR, 'bug-report-api.test.ts')),
      'bug-report-api.test.ts should exist'
    ).toBe(true)
  })
})

// MCP catalog search (spine AD-1): one host service, reached through
// `GET /mcp-catalog/search` (web) and the `/ws` request `search_mcp_catalog`
// (desktop channel and web socket). The Rust suite compares the two replies;
// this block pins the wiring and the shared facade.
describe('MCP catalog parity (spine AD-1)', () => {
  const SRC_TAURI = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
  const SHARED_TYPES = join(LIB_DIR, '..', '..', 'shared', 'types')

  it('both carriers answer from the one host service', () => {
    const dispatch = readFileSync(join(SRC_TAURI, 'web', 'ws', 'dispatch.rs'), 'utf-8')
    expect(dispatch).toMatch(/"search_mcp_catalog" => \{\s*mcp_catalog::handle_search_mcp_catalog/)
    const router = readFileSync(join(SRC_TAURI, 'web', 'router', 'mod.rs'), 'utf-8')
    expect(router.match(/"\/mcp-catalog\/search", get\(mcp_catalog_api::search\)/g)).toHaveLength(2)
    for (const adapter of [
      join(SRC_TAURI, 'web', 'mcp_catalog_api.rs'),
      join(SRC_TAURI, 'web', 'ws', 'mcp_catalog.rs')
    ]) {
      expect(readFileSync(adapter, 'utf-8')).toMatch(
        /McpCatalogService::shared\(\)\.await\.search\(&request\)/
      )
    }
  })

  it('search is a read every connection may make, behind the bearer gate on HTTP', () => {
    const capabilities = readFileSync(join(SRC_TAURI, 'web', 'capabilities.rs'), 'utf-8')
    expect(capabilities).toMatch(/\| "search_mcp_catalog"/)
    const gate = readFileSync(join(SRC_TAURI, 'web', 'router', 'gate.rs'), 'utf-8')
    expect(gate).toMatch(/"\/mcp-catalog\/",/)
    const protocol = readFileSync(join(SHARED_TYPES, 'web-protocol.types.ts'), 'utf-8')
    expect(protocol).toMatch(/'search_mcp_catalog',/)
    expect(protocol).toMatch(/search_mcp_catalog: \['read', null\]/)
  })

  it('the facade switches carriers and both impls share the contract types', () => {
    const facade = readFileSync(join(LIB_DIR, 'mcp-catalog-api.ts'), 'utf-8')
    expect(facade).toMatch(
      /isTauriContext\(\)\s*\?\s*createDesktopMcpCatalogApi\(\)\s*:\s*webMcpCatalogApi/
    )
    const desktop = readFileSync(join(LIB_DIR, 'desktop-mcp-catalog-api.ts'), 'utf-8')
    expect(desktop).toMatch(/getAcpTransport\(\)\.searchMcpCatalog\(request\)/)
    expect(desktop).toMatch(/ipcResultFromTransport/)
    const web = readFileSync(join(LIB_DIR, 'web-mcp-catalog-api.ts'), 'utf-8')
    expect(web).toMatch(/\/mcp-catalog\/search/)
    const transport = readTsModule(join(LIB_DIR, 'acp-transport'))
    expect(transport).toMatch(/'search_mcp_catalog'/)
    for (const impl of [desktop, web, facade]) {
      expect(impl).toMatch(/from '@shared\/types\/mcp-catalog\.types'/)
    }
    const types = readFileSync(join(SHARED_TYPES, 'mcp-catalog.types.ts'), 'utf-8')
    expect(types).toMatch(/export interface McpCatalogApi\b/)
    expect(existsSync(join(LIB_DIR, 'mcp-catalog-api.test.ts'))).toBe(true)
  })
})

// Every Operations row of the automation contract: the facade method, the
// Tauri command registered in lib.rs, and the HTTP route merged into both
// router variants, all over the one host service.
describe('Automation parity (facade)', () => {
  const Facade = join(LIB_DIR, 'automation-api.ts')
  const SRC_TAURI = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
  const readTauri = (...parts: string[]): string => readFileSync(join(SRC_TAURI, ...parts), 'utf-8')

  const OPERATIONS = [
    {
      fn: 'listAutomations',
      method: 'list',
      command: 'automation_list',
      http: '"/api/automations"',
      route: 'AUTOMATIONS}?project_id='
    },
    {
      fn: 'getAutomation',
      method: 'get',
      command: 'automation_get',
      http: '"/api/automations/{id}"',
      route: 'AUTOMATIONS}/${seg(id)}`'
    },
    {
      fn: 'createAutomation',
      method: 'create',
      command: 'automation_create',
      http: '"/api/automations"',
      route: 'postJsonOnce(AUTOMATIONS,'
    },
    {
      fn: 'applyAutomationOps',
      method: 'applyOps',
      command: 'automation_apply_ops',
      http: '"/api/automations/{id}/ops"',
      route: '/ops`'
    },
    {
      fn: 'deleteAutomation',
      method: 'remove',
      command: 'automation_delete',
      http: '"/api/automations/{id}"',
      route: 'deleteJson(`${AUTOMATIONS}/${seg(id)}`)'
    },
    {
      fn: 'setAutomationEnabled',
      method: 'setEnabled',
      command: 'automation_set_enabled',
      http: '"/api/automations/{id}/enabled"',
      route: '/enabled`'
    },
    {
      fn: 'approveAutomation',
      method: 'approve',
      command: 'automation_approve',
      http: '"/api/automations/{id}/approve"',
      route: '/approve`'
    },
    {
      fn: 'runAutomationNow',
      method: 'runNow',
      command: 'automation_run_now',
      http: '"/api/automations/{id}/run"',
      route: '/run`'
    },
    {
      fn: 'cancelAutomationRun',
      method: 'cancelRun',
      command: 'automation_cancel_run',
      http: '"/api/automation-runs/{run_id}/cancel"',
      route: 'RUNS}/${seg(runId)}/cancel`'
    },
    {
      fn: 'listAutomationRuns',
      method: 'listRuns',
      command: 'automation_list_runs',
      http: '"/api/automations/{id}/runs"',
      route: '/runs?limit='
    },
    {
      fn: 'getAutomationRunSteps',
      method: 'runSteps',
      command: 'automation_run_steps',
      http: '"/api/automation-runs/{run_id}/steps"',
      route: 'RUNS}/${seg(runId)}/steps`'
    },
    {
      fn: 'markAutomationSeen',
      method: 'markSeen',
      command: 'automation_mark_seen',
      http: '"/api/automations/{id}/seen"',
      route: '/seen`'
    },
    {
      fn: 'previewSchedule',
      method: 'previewSchedule',
      command: 'automation_preview_schedule',
      http: '"/api/automations/preview-schedule"',
      route: '/preview-schedule`'
    },
    {
      fn: 'listAutomationAgents',
      method: 'listAgents',
      command: 'automation_list_agents',
      http: '"/api/automation-agents"',
      route: "'/api/automation-agents'"
    },
    {
      fn: 'listAutomationSecrets',
      method: 'listSecrets',
      command: 'automation_list_secrets',
      http: '"/api/automation-secrets"',
      route: 'getJson(`${SECRETS}?project_id='
    },
    {
      fn: 'setAutomationSecret',
      method: 'setSecret',
      command: 'automation_set_secret',
      http: '"/api/automation-secrets"',
      route: 'putJson(SECRETS,'
    },
    {
      fn: 'deleteAutomationSecret',
      method: 'deleteSecret',
      command: 'automation_delete_secret',
      http: '"/api/automation-secrets"',
      route: 'deleteJson(`${SECRETS}?project_id='
    }
  ] as const

  for (const op of OPERATIONS) {
    it(`${op.fn} goes through ${op.command} on desktop and its route on web`, () => {
      const facade = readFileSync(Facade, 'utf-8')
      expect(facade).toMatch(new RegExp(`export (async )?function ${op.fn}\\(`))
      expect(facade).toContain(`transport().${op.method}(`)
      expect(facade).toContain(`'${op.command}'`)
      expect(facade).toContain(op.route)
    })

    it(`${op.command} is defined, registered in lib.rs, and ${op.http} is served`, () => {
      expect(readTauri('commands', 'automation.rs')).toContain(`pub async fn ${op.command}(`)
      expect(readTauri('lib.rs')).toContain(`commands::${op.command},`)
      expect(readTauri('web', 'automation_api.rs')).toContain(op.http)
    })
  }

  it('both router variants merge the automation routes behind the bearer gate', () => {
    const router = readTauri('web', 'router', 'mod.rs')
    expect(router.split('automation_api::automation_router(').length - 1).toBe(2)
    expect(readTauri('web', 'router', 'gate.rs')).toMatch(
      /const GATED_PREFIXES[^;]*"\/api\/automation"/s
    )
  })

  it('commands run only from the main webview', () => {
    expect(readTauri('commands', 'automation.rs')).toMatch(/webview\.label\(\) != "main"/)
  })

  it('both hosts forward service changes only to the agents watch', () => {
    expect(readTauri('web', 'automation_api.rs')).toContain(
      'publish_agent_event(&relay, EVENT_AUTOMATION_CHANGED'
    )
    const desktop = readTauri('lib.rs')
    expect(desktop).toContain('web::automation_api::forward_changes(')
    expect(desktop).not.toContain('EVENT_AUTOMATION_CHANGED')
    expect(readTauri('web', 'mod.rs')).toContain('automation_api::forward_changes(')
    expect(readTauri('automation', 'model.rs')).toContain(
      'EVENT_AUTOMATION_CHANGED: &str = "automation_changed"'
    )
  })

  it('the facade switches carriers and takes change events only from the roster watch', () => {
    const facade = readFileSync(Facade, 'utf-8')
    expect(facade).toMatch(
      /isTauriContext\(\) \? desktopAutomationTransport : webAutomationTransport/
    )
    expect(facade).toContain("AUTOMATION_CHANGED_EVENT = 'automation_changed'")
    expect(facade).not.toContain('@tauri-apps/api/event')
    const roster = readFileSync(
      join(LIB_DIR, '..', 'stores', 'acp-store', 'agent-roster-watch.ts'),
      'utf-8'
    )
    expect(roster).toContain("'automation_changed'")
    expect(roster).toContain('publishAutomationChange')
    expect(facade).toContain("from './log-api'")
  })
})

describe('GitHub parity (spec-github-integration)', () => {
  const SRC_TAURI = join(LIB_DIR, '..', '..', '..', 'src-tauri', 'src')
  const read = (...parts: string[]) => readFileSync(join(SRC_TAURI, ...parts), 'utf-8')
  const facade = readFileSync(join(LIB_DIR, 'github-api.ts'), 'utf-8')
  const ops = [
    {
      method: 'getContext',
      command: 'github_get_context',
      route: '/github/context',
      handler: 'context'
    },
    {
      method: 'listItems',
      command: 'github_list_items',
      route: '/github/items',
      handler: 'list_items'
    },
    { method: 'getItem', command: 'github_get_item', route: '/github/item', handler: 'get_item' },
    {
      method: 'getChecks',
      command: 'github_get_checks',
      route: '/github/checks',
      handler: 'get_checks'
    },
    {
      method: 'getCheckLog',
      command: 'github_get_check_log',
      route: '/github/check-log',
      handler: 'get_check_log'
    },
    { method: 'merge', command: 'github_merge', route: '/github/merge', handler: 'merge' },
    { method: 'comment', command: 'github_comment', route: '/github/comment', handler: 'comment' },
    {
      method: 'checkoutPr',
      command: 'github_checkout_pr',
      route: '/github/checkout-pr',
      handler: 'checkout_pr'
    }
  ]
  const writeHandlers = new Set(['merge', 'comment', 'checkout_pr'])

  it('the facade branches on isTauriContext() between invokeIpc({ request }) and postJson', () => {
    expect(facade).toMatch(/isTauriContext\(\)\s*\?\s*await invokeIpc<T>\(command, \{ request \}\)/)
    expect(facade).toMatch(/await postJson<T>\(route, request\)/)
  })

  it.each(ops)('$command is wired through the facade, lib.rs, commands and both routers', (op) => {
    expect(facade).toMatch(
      new RegExp(`${op.method}\\([^)]*\\)[^{]*\\{\\s*return call\\('${op.command}', '${op.route}'`)
    )
    expect(read('lib.rs')).toContain(`commands::${op.command},`)
    expect(read('commands', 'github.rs')).toMatch(
      new RegExp(`pub async fn ${op.command}\\(\\s*request:`)
    )
    const router = read('web', 'router', 'mod.rs')
    const registration = `.route("${op.route}", post(github_api::${op.handler}))`
    expect(router.split(registration).length - 1, 'router() and router_with_static()').toBe(2)
    expect(read('web', 'github_api.rs')).toMatch(new RegExp(`pub async fn ${op.handler}\\(`))
  })

  it('/github/* is token-gated, and exactly the write routes take the remote-write guard', () => {
    expect(read('web', 'router', 'gate.rs')).toContain('"/github/",')
    const routes = read('web', 'github_api.rs')
    expect(routes.match(/check_local_only::</g)?.length).toBe(1)
    for (const op of ops) {
      const handler = routes.match(new RegExp(`pub async fn ${op.handler}\\([\\s\\S]*?\\n}`))?.[0]
      expect(handler, op.handler).toBeDefined()
      const guarded = new RegExp(
        `ConnectInfo\\(peer\\)[\\s\\S]*write_refused\\(&state, peer, "${op.route}"\\)`
      )
      if (writeHandlers.has(op.handler)) {
        expect(handler, op.handler).toMatch(guarded)
      } else {
        expect(handler, op.handler).not.toContain('ConnectInfo')
      }
    }
    expect(routes).toMatch(/resolve_cwd::<T>\(cwd, state, None, false\)/)
  })

  it('every TS error code is a Rust GithubError code and vice versa', () => {
    const types = readFileSync(
      join(LIB_DIR, '..', '..', 'shared', 'types', 'github.types.ts'),
      'utf-8'
    )
    const list = types.match(/GITHUB_ERROR_CODES = \[([\s\S]*?)\] as const/)?.[1] ?? ''
    const tsCodes = [...list.matchAll(/'(GH_[A-Z_]+)'/g)].map((m) => m[1]).sort()
    const rustCodes = [...read('github', 'error.rs').matchAll(/=> "(GH_[A-Z_]+)"/g)]
      .map((m) => m[1])
      .sort()
    expect(tsCodes.length).toBe(11)
    expect(rustCodes).toEqual(tsCodes)
  })
})
