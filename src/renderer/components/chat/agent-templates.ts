/**
 * Pre-configured ACP agent templates. Pure data — used to prefill the
 * AgentConfigDialog. Users can edit before saving.
 */
import type { AgentConfig } from '@/lib/acp-api'

export interface AgentTemplate {
  id: string
  label: string
  notes: string
  config: AgentConfig
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    notes: 'Google’s reference ACP agent. Requires the gemini CLI on PATH.',
    config: { name: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'], env: {} }
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    notes: 'Anthropic Claude Code via the Zed ACP adapter (npx).',
    config: {
      name: 'Claude Code',
      command: 'npx',
      args: ['@zed-industries/claude-code-acp'],
      env: { ANTHROPIC_API_KEY: '$ANTHROPIC_API_KEY' }
    }
  },
  {
    id: 'codex',
    label: 'Codex',
    notes: 'OpenAI Codex CLI (if it exposes an ACP mode).',
    config: { name: 'Codex', command: 'codex', args: [], env: {} }
  },
  {
    id: 'custom',
    label: 'Custom',
    notes: 'Define your own command, arguments, and environment.',
    config: { name: '', command: '', args: [], env: {} }
  }
]

export function templateById(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.id === id)
}
