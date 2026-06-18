import type { StoredAgentConfig } from '@/lib/acp-agents-persistence'
import {
  deriveAgentConfig,
  REGISTRY_AGENTS,
  type RegistryAgent,
  type RegistryBinaryTarget
} from '@/lib/agents/acp-registry'

export const SUPPORTED_ACP_AGENT_IDS = [
  'codex-acp',
  'claude-acp',
  'gemini',
  'cursor',
  'opencode',
  'pi-acp'
] as const

export type SupportedAcpAgentId = (typeof SUPPORTED_ACP_AGENT_IDS)[number]

export type SupportedAcpAgentStatus = 'ready' | 'install-required' | 'unavailable'

export interface SupportedAcpAgentInstall {
  archiveUrl: string
  cmd: string
  args: string[]
  env: Record<string, string>
}

export interface SupportedAcpAgentEntry {
  id: SupportedAcpAgentId
  configId: string
  agent: RegistryAgent
  config: StoredAgentConfig | null
  status: SupportedAcpAgentStatus
  install: SupportedAcpAgentInstall | null
  unavailableReason: string | null
}

export function registryConfigId(registryId: string): string {
  return `acp-registry:${registryId}`
}

function isSupportedAcpAgentId(id: string): id is SupportedAcpAgentId {
  return (SUPPORTED_ACP_AGENT_IDS as readonly string[]).includes(id)
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

export function buildSupportedAcpAgents(
  persistedConfigs: readonly StoredAgentConfig[],
  platformArch: string,
  registry: readonly RegistryAgent[] = REGISTRY_AGENTS
): SupportedAcpAgentEntry[] {
  const persistedById = new Map(persistedConfigs.map((config) => [config.id, config]))
  const registryById = new Map(registry.map((agent) => [agent.id, agent]))
  const entries: SupportedAcpAgentEntry[] = []

  for (const id of SUPPORTED_ACP_AGENT_IDS) {
    const agent = registryById.get(id)
    if (!agent) continue
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
        unavailableReason: null
      })
      continue
    }

    const derived = deriveAgentConfig(agent, platformArch)
    if (derived.kind === 'runnable') {
      entries.push({
        id,
        configId,
        agent,
        config: toStoredConfig(agent, derived.config),
        status: 'ready',
        install: null,
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
        unavailableReason: null
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
      unavailableReason:
        derived.kind === 'needs-install'
          ? 'This platform build must be installed manually.'
          : 'This agent is not available for your platform.'
    })
  }

  return entries
}

export function isSupportedAcpConfigId(configId: string): boolean {
  const id = configId.startsWith('acp-registry:')
    ? configId.slice('acp-registry:'.length)
    : configId
  return isSupportedAcpAgentId(id)
}
