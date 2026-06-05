/**
 * Pre-configured ACP agent templates, sourced from the official ACP registry
 * (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json).
 *
 * Used to resolve a configured ACP agent's icon by template id. Commands
 * favor the registry's `npx` distribution where available (zero install) and
 * the direct binary name where the agent is expected on PATH. Icons are
 * vendored inline (see `acp-agent-icons.tsx`) and rendered theme-adaptively via
 * `currentColor`.
 */
import type { ComponentType, SVGProps } from 'react'
import type { AgentConfig } from '@/lib/acp-api'
import {
  CodexIcon,
  CopilotIcon,
  CursorIcon,
  GeminiIcon,
  GooseIcon,
  KimiIcon,
  OpenCodeIcon,
  QwenIcon
} from './acp-agent-icons'

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

export interface AgentTemplate {
  id: string
  label: string
  notes: string
  /** Inline icon component (theme-adaptive via currentColor), if available. */
  icon?: IconComponent
  config: AgentConfig
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'gemini',
    label: 'Gemini CLI',
    notes: "Google's official CLI for Gemini. Runs via npx.",
    icon: GeminiIcon,
    config: {
      name: 'Gemini CLI',
      command: 'npx',
      args: ['-y', '@google/gemini-cli', '--acp'],
      env: {},
      allowTerminal: false
    }
  },
  {
    id: 'claude-acp',
    label: 'Claude Agent',
    notes: "ACP wrapper for Anthropic's Claude. Runs via npx.",
    config: {
      name: 'Claude Agent',
      command: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp'],
      env: { ANTHROPIC_API_KEY: '$ANTHROPIC_API_KEY' },
      allowTerminal: false
    }
  },
  {
    id: 'codex-acp',
    label: 'Codex CLI',
    notes: "ACP adapter for OpenAI's Codex. Runs via npx.",
    icon: CodexIcon,
    config: {
      name: 'Codex CLI',
      command: 'npx',
      args: ['-y', '@zed-industries/codex-acp'],
      env: {},
      allowTerminal: false
    }
  },
  {
    id: 'github-copilot-cli',
    label: 'GitHub Copilot',
    notes: "GitHub's AI pair programmer CLI. Runs via npx.",
    icon: CopilotIcon,
    config: {
      name: 'GitHub Copilot',
      command: 'npx',
      args: ['-y', '@github/copilot', '--acp'],
      env: {},
      allowTerminal: false
    }
  },
  {
    id: 'qwen-code',
    label: 'Qwen Code',
    notes: "Alibaba's Qwen coding assistant. Runs via npx.",
    icon: QwenIcon,
    config: {
      name: 'Qwen Code',
      command: 'npx',
      args: ['-y', '@qwen-code/qwen-code', '--acp'],
      env: {},
      allowTerminal: false
    }
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    notes: 'The open source coding agent. Requires the opencode binary on PATH.',
    icon: OpenCodeIcon,
    config: {
      name: 'OpenCode',
      command: 'opencode',
      args: ['acp'],
      env: {},
      allowTerminal: false
    }
  },
  {
    id: 'goose',
    label: 'goose',
    notes: "Block's local, extensible open-source agent. Requires the goose binary on PATH.",
    icon: GooseIcon,
    config: {
      name: 'goose',
      command: 'goose',
      args: ['acp'],
      env: {},
      allowTerminal: false
    }
  },
  {
    id: 'cursor',
    label: 'Cursor',
    notes: "Cursor's coding agent. Requires the cursor-agent binary on PATH.",
    icon: CursorIcon,
    config: {
      name: 'Cursor',
      command: 'cursor-agent',
      args: ['acp'],
      env: {},
      allowTerminal: false
    }
  },
  {
    id: 'kimi',
    label: 'Kimi CLI',
    notes: "Moonshot AI's coding assistant. Requires the kimi binary on PATH.",
    icon: KimiIcon,
    config: {
      name: 'Kimi CLI',
      command: 'kimi',
      args: ['acp'],
      env: {},
      allowTerminal: false
    }
  },
  {
    id: 'cline',
    label: 'Cline',
    notes: 'Autonomous coding agent CLI. Runs via npx.',
    config: {
      name: 'Cline',
      command: 'npx',
      args: ['-y', 'cline', '--acp'],
      env: {},
      allowTerminal: false
    }
  },
  {
    id: 'auggie',
    label: 'Auggie CLI',
    notes: "Augment Code's software agent. Runs via npx.",
    config: {
      name: 'Auggie CLI',
      command: 'npx',
      args: ['-y', '@augmentcode/auggie', '--acp'],
      env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
      allowTerminal: false
    }
  },
  {
    id: 'custom',
    label: 'Custom',
    notes: 'Define your own command, arguments, and environment.',
    config: { name: '', command: '', args: [], env: {}, allowTerminal: false }
  }
]

export function templateById(id: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find((t) => t.id === id)
}

/** Resolve an icon component for a template id, if one exists. */
export function templateIcon(id: string | undefined): IconComponent | undefined {
  return id ? templateById(id)?.icon : undefined
}
