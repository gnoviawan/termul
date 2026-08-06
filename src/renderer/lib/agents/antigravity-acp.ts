import type { RegistryAgent, RegistryBinaryTarget } from '@/lib/agents/acp-registry'

export const ANTIGRAVITY_ACP_ID = 'antigravity-acp'
export const ANTIGRAVITY_ACP_RELEASE = '1.0.0'
export const ANTIGRAVITY_ACP_REPOSITORY_URL = 'https://github.com/shubzkothekar/antigravity-acp'
export const ANTIGRAVITY_ACP_TERMS_URL = 'https://antigravity.google/terms'
export const ANTIGRAVITY_ACP_RELEASE_URL = `${ANTIGRAVITY_ACP_REPOSITORY_URL}/releases/tag/v${ANTIGRAVITY_ACP_RELEASE}`

export interface AntigravityAcpReleaseTarget {
  fileName: string
  downloadUrl: string
  sha256: string
}

const releaseTarget = (fileName: string, sha256: string): AntigravityAcpReleaseTarget => ({
  fileName,
  downloadUrl: `${ANTIGRAVITY_ACP_REPOSITORY_URL}/releases/download/v${ANTIGRAVITY_ACP_RELEASE}/${fileName}`,
  sha256
})

export const ANTIGRAVITY_ACP_RELEASE_TARGETS: Readonly<
  Record<string, AntigravityAcpReleaseTarget>
> = {
  'darwin-aarch64': releaseTarget(
    'agy-acp-darwin-arm64',
    '7936bd5fd662e6514755a8e8b19aba88b2f01b94d082d93bbc238cb4bdc9c2e8'
  ),
  'darwin-x86_64': releaseTarget(
    'agy-acp-darwin-x64',
    '4265454974b67142061539270fb6401229034098590762b2b0c30be68ff5ebdc'
  ),
  'linux-aarch64': releaseTarget(
    'agy-acp-linux-arm64',
    '7eec158411e1939c6ad6298b52ee2691425b666a448ee12c07ccf59b55067652'
  ),
  'linux-x86_64': releaseTarget(
    'agy-acp-linux-x64',
    'ed900c0ebb72ff505ec5c64296b534472927140514aacad607af645320e6a3d1'
  ),
  'windows-aarch64': releaseTarget(
    'agy-acp-windows-arm64.exe',
    'c55280bb358e4b9ea18091e955341ffc43057ef2babfdba7ebe1c31b9bb2f6d1'
  ),
  'windows-x86_64': releaseTarget(
    'agy-acp-windows-x64.exe',
    'f58efda098e9df50a15a9efe3c965f954e0f508838e0665ba9471ee29efe3503'
  )
}

const binary: Record<string, RegistryBinaryTarget> = Object.fromEntries(
  Object.entries(ANTIGRAVITY_ACP_RELEASE_TARGETS).map(([platformArch, target]) => [
    platformArch,
    { cmd: target.fileName }
  ])
)

export const ANTIGRAVITY_ACP_AGENT: RegistryAgent = {
  id: ANTIGRAVITY_ACP_ID,
  name: 'Antigravity',
  version: ANTIGRAVITY_ACP_RELEASE,
  description: "ACP bridge for Google Antigravity's agy CLI.",
  distribution: { binary }
}

export const APP_OWNED_ACP_AGENTS: readonly RegistryAgent[] = [ANTIGRAVITY_ACP_AGENT]

export function isAntigravityAcpAgentId(id: string | undefined): boolean {
  return id === ANTIGRAVITY_ACP_ID
}

export function getAntigravityAcpReleaseTarget(
  platformArch: string
): AntigravityAcpReleaseTarget | null {
  return ANTIGRAVITY_ACP_RELEASE_TARGETS[platformArch] ?? null
}

/** Keep app-owned integrations available when the user applies a remote registry. */
export function mergeAppOwnedAcpAgents(registry: readonly RegistryAgent[]): RegistryAgent[] {
  const appOwnedIds = new Set(APP_OWNED_ACP_AGENTS.map((agent) => agent.id))
  return [...registry.filter((agent) => !appOwnedIds.has(agent.id)), ...APP_OWNED_ACP_AGENTS]
}
