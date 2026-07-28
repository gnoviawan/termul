import type { AgentConfig } from '@/lib/acp-api'

const ENOENT_PATTERN = /enoent|not found|cannot find|no such file|program not found|spawn.*fail/i

export function formatAcpSpawnError(raw: unknown, config?: Pick<AgentConfig, 'command'>): string {
  const message = raw instanceof Error ? raw.message : String(raw)
  if (!ENOENT_PATTERN.test(message)) return message

  if (config?.command === 'npx') {
    return 'Could not run npx. Install Node.js and ensure npx is on your PATH, then try again.'
  }
  if (config?.command === 'uvx') {
    return 'Could not run uvx. Install uv and ensure uvx is on your PATH, then try again.'
  }
  if (config?.command) {
    return `Could not start "${config.command}". Check that the binary exists and is on your PATH.`
  }
  return 'Could not start the ACP agent. Check that the command exists and is on your PATH.'
}
