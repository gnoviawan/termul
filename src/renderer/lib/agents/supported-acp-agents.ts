import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import {
  deriveAgentConfig,
  REGISTRY_AGENTS,
  type RegistryAgent,
  type RegistryBinaryTarget
} from '@/lib/agents/acp-registry'
import { APP_OWNED_ACP_AGENTS, isAntigravityAcpAgentId } from '@/lib/agents/antigravity-acp'

const REGISTRY_AGENT_IDS = new Set(
  [...REGISTRY_AGENTS, ...APP_OWNED_ACP_AGENTS].map((agent) => agent.id)
)

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
  const eligible = entries.filter((entry) => !isAntigravityAcpAgentId(entry.agent.id))
  for (const id of PREFERRED_DEFAULT_ACP_AGENT_IDS) {
    const match = eligible.find((entry) => entry.id === id && entry.status === 'ready')
    if (match) return match
  }
  return eligible.find((entry) => entry.status === 'ready') ?? eligible[0] ?? null
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
