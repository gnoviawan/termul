import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import {
  deriveAgentConfig,
  REGISTRY_AGENTS,
  type RegistryAgent,
  type RegistryBinaryTarget
} from '@/lib/agents/acp-registry'
import { acpCatalogApi } from '@/lib/api'

const REGISTRY_AGENT_IDS = new Set(REGISTRY_AGENTS.map((agent) => agent.id))

/** Preferred default when no last-selected agent is persisted. */
export const PREFERRED_DEFAULT_ACP_AGENT_IDS = [
  'codex-acp',
  'claude-acp',
  'gemini',
  'cursor',
  'opencode',
  'pi-acp'
] as const

export function pickDefaultSupportedAgent(
  entries: readonly SupportedAcpAgentEntry[]
): SupportedAcpAgentEntry | null {
  for (const id of PREFERRED_DEFAULT_ACP_AGENT_IDS) {
    const match = entries.find((entry) => entry.id === id && entry.status === 'ready')
    if (match) return match
  }
  return entries.find((entry) => entry.status === 'ready') ?? entries[0] ?? null
}

export function filterSupportedAcpAgents(
  entries: readonly SupportedAcpAgentEntry[],
  query: string
): SupportedAcpAgentEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...entries]
  return entries.filter(
    (entry) =>
      entry.agent.name.toLowerCase().includes(q) ||
      entry.agent.id.toLowerCase().includes(q) ||
      entry.agent.description.toLowerCase().includes(q)
  )
}

export interface AcpRuntimeAvailability {
  npx: boolean
  uvx: boolean
}

export type SupportedAcpAgentStatus =
  | 'ready'
  | 'install-required'
  | 'needs-runtime'
  | 'manual-install'
  | 'unavailable'

export interface SupportedAcpAgentInstall {
  archiveUrl: string
  cmd: string
  args: string[]
  env: Record<string, string>
}

export interface SupportedAcpAgentManualInstall {
  cmd: string
  args: string[]
  env: Record<string, string>
}

export interface SupportedAcpAgentEntry {
  id: string
  configId: string
  agent: RegistryAgent
  config: StoredAgentConfig | null
  status: SupportedAcpAgentStatus
  install: SupportedAcpAgentInstall | null
  manualInstall: SupportedAcpAgentManualInstall | null
  runtimeLauncher: 'npx' | 'uvx' | null
  unavailableReason: string | null
}

export function registryConfigId(registryId: string): string {
  return `acp-registry:${registryId}`
}

function runtimeUnavailableReason(launcher: 'npx' | 'uvx'): string {
  return launcher === 'npx'
    ? 'Install Node.js so npx is available on your PATH.'
    : 'Install uv so uvx is available on your PATH.'
}

function manualInstallReason(agent: RegistryAgent, cmd: string, args: string[]): string {
  const suffix = args.length > 0 ? ` ${args.join(' ')}` : ''
  return `Install ${agent.name} from the vendor, then ensure \`${cmd}${suffix}\` is on your PATH.`
}

function toStoredConfig(agent: RegistryAgent, config: StoredAgentConfig): StoredAgentConfig
function toStoredConfig(
  agent: RegistryAgent,
  config: Omit<StoredAgentConfig, 'id' | 'templateId'>
): StoredAgentConfig
function toStoredConfig(
  agent: RegistryAgent,
  config: StoredAgentConfig | Omit<StoredAgentConfig, 'id' | 'templateId'>
): StoredAgentConfig {
  return {
    id: registryConfigId(agent.id),
    templateId: agent.id,
    ...config
  }
}

export function installedBinaryConfig(
  agent: RegistryAgent,
  installed: { command: string; args: string[] },
  target: Pick<RegistryBinaryTarget, 'env'> = {}
): StoredAgentConfig {
  return toStoredConfig(agent, {
    name: agent.name,
    command: installed.command,
    args: installed.args,
    env: { ...(target.env ?? {}) },
    allowTerminal: false
  })
}

export function manualBinaryConfig(
  agent: RegistryAgent,
  command: string,
  manual: SupportedAcpAgentManualInstall
): StoredAgentConfig {
  return installedBinaryConfig(
    agent,
    { command: command.trim(), args: manual.args },
    { env: manual.env }
  )
}

export function buildSupportedAcpAgents(
  persistedConfigs: readonly StoredAgentConfig[],
  platformArch: string,
  registry: readonly RegistryAgent[] = REGISTRY_AGENTS,
  runtime: AcpRuntimeAvailability | null = null
): SupportedAcpAgentEntry[] {
  const persistedById = new Map(persistedConfigs.map((config) => [config.id, config]))
  const entries: SupportedAcpAgentEntry[] = []

  for (const agent of [...registry].sort((a, b) => a.name.localeCompare(b.name))) {
    const id = agent.id
    const configId = registryConfigId(id)
    const persisted = persistedById.get(configId)
    if (persisted) {
      entries.push({
        id,
        configId,
        agent,
        config: persisted,
        status: 'ready',
        install: null,
        manualInstall: null,
        runtimeLauncher: null,
        unavailableReason: null
      })
      continue
    }

    const derived = deriveAgentConfig(agent, platformArch)
    if (derived.kind === 'runnable') {
      const launcher =
        derived.config.command === 'npx' || derived.config.command === 'uvx'
          ? derived.config.command
          : null
      if (launcher === 'npx' && runtime !== null && !runtime.npx) {
        entries.push({
          id,
          configId,
          agent,
          config: null,
          status: 'needs-runtime',
          install: null,
          manualInstall: null,
          runtimeLauncher: 'npx',
          unavailableReason: runtimeUnavailableReason('npx')
        })
        continue
      }
      if (launcher === 'uvx' && runtime !== null && !runtime.uvx) {
        entries.push({
          id,
          configId,
          agent,
          config: null,
          status: 'needs-runtime',
          install: null,
          manualInstall: null,
          runtimeLauncher: 'uvx',
          unavailableReason: runtimeUnavailableReason('uvx')
        })
        continue
      }
      entries.push({
        id,
        configId,
        agent,
        config: toStoredConfig(agent, derived.config),
        status: 'ready',
        install: null,
        manualInstall: null,
        runtimeLauncher: null,
        unavailableReason: null
      })
      continue
    }
    if (derived.kind === 'needs-install' && derived.archiveUrl) {
      entries.push({
        id,
        configId,
        agent,
        config: null,
        status: 'install-required',
        install: {
          archiveUrl: derived.archiveUrl,
          cmd: derived.cmd,
          args: derived.args,
          env: derived.env
        },
        manualInstall: null,
        runtimeLauncher: null,
        unavailableReason: null
      })
      continue
    }
    if (derived.kind === 'needs-install') {
      entries.push({
        id,
        configId,
        agent,
        config: null,
        status: 'manual-install',
        install: null,
        manualInstall: {
          cmd: derived.cmd,
          args: derived.args,
          env: derived.env
        },
        runtimeLauncher: null,
        unavailableReason: manualInstallReason(agent, derived.cmd, derived.args)
      })
      continue
    }
    entries.push({
      id,
      configId,
      agent,
      config: null,
      status: 'unavailable',
      install: null,
      manualInstall: null,
      runtimeLauncher: null,
      unavailableReason: 'This agent is not available for your platform.'
    })
  }

  return entries
}

export function isSupportedAcpConfigId(configId: string): boolean {
  const id = configId.startsWith('acp-registry:')
    ? configId.slice('acp-registry:'.length)
    : configId
  return REGISTRY_AGENT_IDS.has(id)
}

/**
 * CAP-6 / Story 8: resolve supported ACP agents from the host-resolved
 * catalog. Replaces the renderer-side `buildSupportedAcpAgents(...)` derivation
 * (which used `@tauri-apps/plugin-os` — a desktop-only API) with a call to
 * `acpCatalogApi.listCatalog()`. The host resolves OS/arch/runtime + per-agent
 * `SupportedAcpAgentStatus`; the renderer maps `CatalogAgent` →
 * `SupportedAcpAgentEntry` (preserving the existing export shape so callers
 * like `useAcpAgents` don't change their consumption shape).
 *
 * The existing `buildSupportedAcpAgents(...)` is kept for backward compat
 * (tests + existing callers that pass a platform arch directly); the call
 * sites (`useAcpAgents`, `AgentLauncher`, `AcpAgentsSettings`) switch to this
 * async wrapper.
 */
export async function resolveSupportedAcpAgents(
  persistedConfigs: readonly StoredAgentConfig[]
): Promise<SupportedAcpAgentEntry[]> {
  const result = await acpCatalogApi.listCatalog()
  if (!result.success) {
    // Degrade gracefully: return an empty list (callers fall back to the
    // default-agent selection which handles empty lists).
    return []
  }
  const catalog = result.data
  const persistedById = new Map(persistedConfigs.map((config) => [config.id, config]))
  const entries: SupportedAcpAgentEntry[] = []

  for (const agent of catalog.agents) {
    const id = agent.id
    const configId = registryConfigId(id)
    const persisted = persistedById.get(configId)

    // Map the host-resolved status to the existing SupportedAcpAgentEntry shape.
    // The host already computed the status (ready / install-required /
    // needs-runtime / manual-install / unavailable); we just project it.
    const registryAgent: RegistryAgent = {
      id: agent.id,
      name: agent.name,
      version: agent.version,
      description: agent.description,
      distribution: agent.distribution as RegistryAgent['distribution']
    }

    if (persisted) {
      entries.push({
        id,
        configId,
        agent: registryAgent,
        config: persisted,
        status: 'ready',
        install: null,
        manualInstall: null,
        runtimeLauncher: null,
        unavailableReason: null
      })
      continue
    }

    // Derive the install/manualInstall info from the distribution (for
    // binary-distributed agents) — the host reports the status but the
    // renderer still needs the archive URL + cmd for the install UI.
    // The host keeps `host.os` as the raw `std::env::consts::OS` value
    // ("macos" on macOS) for display, but the bundled catalog's binary map
    // keys use "darwin-*". Map "macos" -> "darwin" for the binary-target
    // lookup (mirrors the host's `host_platform_arch()` helper); without this
    // the install/manualInstall cmd would miss every "darwin-*" entry on macOS.
    const binaryMapOs = catalog.host.os === 'macos' ? 'darwin' : catalog.host.os
    const derived = deriveAgentConfig(registryAgent, `${binaryMapOs}-${catalog.host.arch}`)

    entries.push({
      id,
      configId,
      agent: registryAgent,
      config: derived.kind === 'runnable' ? toStoredConfig(registryAgent, derived.config) : null,
      status: agent.status,
      install:
        derived.kind === 'needs-install' && derived.archiveUrl
          ? {
              archiveUrl: derived.archiveUrl,
              cmd: derived.cmd,
              args: derived.args,
              env: derived.env
            }
          : null,
      manualInstall:
        derived.kind === 'needs-install' && !derived.archiveUrl
          ? { cmd: derived.cmd, args: derived.args, env: derived.env }
          : null,
      runtimeLauncher:
        derived.kind === 'runnable' &&
        (derived.config.command === 'npx' || derived.config.command === 'uvx')
          ? (derived.config.command as 'npx' | 'uvx')
          : null,
      unavailableReason:
        agent.status === 'unavailable'
          ? 'This agent is not available for your platform.'
          : agent.status === 'needs-runtime'
            ? runtimeUnavailableReason(
                derived.kind === 'runnable' && derived.config.command === 'uvx' ? 'uvx' : 'npx'
              )
            : agent.status === 'manual-install' && derived.kind === 'needs-install'
              ? manualInstallReason(registryAgent, derived.cmd, derived.args)
              : null
    })
  }

  return entries
}
