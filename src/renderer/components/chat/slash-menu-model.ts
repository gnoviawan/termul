/**
 * Pure helpers for the slash-command menu. Kept free of React/store so they can
 * be unit-tested directly. The menu aggregates three ACP sources into ordered
 * sections and honors the "config options supersede modes" precedence
 * (ADR-003.4).
 */
import type {
  AvailableCommand,
  SessionConfigOption,
  SessionMode,
  SessionModelState,
  SessionModeState
} from '@/lib/acp-api'
import type { AgentSkillSummary } from '@/lib/skills-api'

export interface SlashCommandItem {
  kind: 'command'
  name: string
  description: string | null
}

export interface SlashConfigItem {
  kind: 'config'
  configId: string
  valueId: string
  label: string
  description: string | null
  selected: boolean
}

export interface SlashModeItem {
  kind: 'mode'
  modeId: string
  label: string
  description: string | null
  selected: boolean
}

export interface SlashSessionModelItem {
  kind: 'sessionModel'
  modelId: string
  label: string
  description: string | null
  selected: boolean
}

export interface SlashSkillItem {
  kind: 'skill'
  name: string
  description: string | null
  scope: string
}

export type SlashItem =
  | SlashCommandItem
  | SlashConfigItem
  | SlashModeItem
  | SlashSessionModelItem
  | SlashSkillItem

export interface SlashSection {
  /** Stable key for the section. */
  id: string
  /** Human-readable heading. */
  heading: string
  items: SlashItem[]
}

export interface SlashMenuInput {
  commands: AvailableCommand[]
  configOptions: SessionConfigOption[]
  modes: SessionModeState | null
  /** Unstable ACP session models (pi-acp `session/set_model`). */
  models?: SessionModelState | null
  skills?: AgentSkillSummary[]
  /** The text after the leading `/`, used to filter. */
  filter: string
}

function matches(filter: string, ...fields: (string | null | undefined)[]): boolean {
  const f = filter.trim().toLowerCase()
  if (!f) return true
  return fields.some((x) => (x ?? '').toLowerCase().includes(f))
}

export const KNOWN_CATEGORY_HEADINGS: Record<string, string> = {
  mode: 'Mode',
  model: 'Model',
  thought_level: 'Thinking Level'
}

function headingForCategory(category: string | null | undefined, fallbackName: string): string {
  if (category && KNOWN_CATEGORY_HEADINGS[category]) return KNOWN_CATEGORY_HEADINGS[category]
  // Unknown/custom categories: use the option's own name as the heading.
  return fallbackName
}

/**
 * Build ordered menu sections from the active session's ACP state.
 *
 * Order: Commands first, then each config option as its own section (preserving
 * the agent's array order). When `configOptions` is non-empty, the legacy
 * `modes` section is omitted entirely (precedence). When it is empty, a single
 * legacy Modes section is emitted if modes exist.
 */
export function buildSlashSections(input: SlashMenuInput): SlashSection[] {
  const { commands, configOptions, modes, models = null, skills = [], filter } = input
  const sections: SlashSection[] = []

  const skillItems: SlashItem[] = skills
    .filter((s) => matches(filter, s.name, s.description))
    .map((s) => ({
      kind: 'skill',
      name: s.name,
      description: s.description || null,
      scope: s.scope
    }))
  if (skillItems.length > 0) {
    sections.push({ id: 'skills', heading: 'Skills', items: skillItems })
  }

  const commandItems: SlashItem[] = commands
    .filter((c) => matches(filter, c.name, c.description))
    .map((c) => ({ kind: 'command', name: c.name, description: c.description ?? null }))
  if (commandItems.length > 0) {
    sections.push({ id: 'commands', heading: 'Commands', items: commandItems })
  }

  if (models && models.availableModels.length > 0) {
    const items: SlashItem[] = models.availableModels
      .filter((m) => matches(filter, m.name, m.description, m.modelId))
      .map((m) => ({
        kind: 'sessionModel',
        modelId: m.modelId,
        label: m.name,
        description: m.description ?? null,
        selected: m.modelId === models.currentModelId
      }))
    if (items.length > 0) {
      sections.push({ id: 'session-models', heading: 'Model', items })
    }
  }

  if (configOptions.length > 0) {
    for (const option of configOptions) {
      const items: SlashItem[] = option.options
        .filter((v) => matches(filter, v.name, v.description, option.name))
        .map((v) => ({
          kind: 'config',
          configId: option.id,
          valueId: v.value,
          label: v.name,
          description: v.description ?? null,
          selected: v.value === option.currentValue
        }))
      if (items.length > 0) {
        sections.push({
          id: `config:${option.id}`,
          heading: headingForCategory(option.category, option.name),
          items
        })
      }
    }
  } else if (modes && modes.availableModes.length > 0) {
    const items: SlashItem[] = modes.availableModes
      .filter((m: SessionMode) => matches(filter, m.name, m.description))
      .map((m: SessionMode) => ({
        kind: 'mode',
        modeId: m.id,
        label: m.name,
        description: m.description ?? null,
        selected: m.id === modes.currentModeId
      }))
    if (items.length > 0) {
      sections.push({ id: 'modes', heading: 'Mode', items })
    }
  }

  return sections
}

/** True when the input value is a lone leading slash-token (opens the menu). */
export function isSlashTrigger(value: string): boolean {
  return /^\/\S*$/.test(value)
}

/** Extract the filter text after a leading `/` (empty string for a lone `/`). */
export function slashFilter(value: string): string {
  return isSlashTrigger(value) ? value.slice(1) : ''
}

/** Replace a leading `/token` with `/<name> ` when a command is chosen. */
export function applyCommandToInput(value: string, commandName: string): string {
  if (isSlashTrigger(value)) {
    return `/${commandName} `
  }
  // Defensive: if somehow not a trigger, append.
  return `${value}/${commandName} `
}
