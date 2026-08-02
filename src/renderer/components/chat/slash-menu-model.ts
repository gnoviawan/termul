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

export interface SlashSkillItem {
  kind: 'skill'
  name: string
  description: string | null
  scope: string
}

export type SlashItem = SlashCommandItem | SlashConfigItem | SlashModeItem | SlashSkillItem

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
  const { commands, configOptions, modes, skills = [], filter } = input
  const sections: SlashSection[] = []

  // Dedup against the agent's ACP commands: when a skill shares a name with
  // a command the agent already surfaces natively, the command wins and the
  // skill is hidden so the same name never appears twice. Skills the agent
  // does NOT surface are still listed (fixes the post-#506 "skills missing").
  const commandNames = new Set(commands.map((c) => c.name))
  const skillItems: SlashItem[] = skills
    .filter((s) => matches(filter, s.name, s.description))
    .filter((s) => !commandNames.has(s.name))
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

/** Result of detecting a slash trigger token at any position in the input. */
export interface SlashTriggerMatch {
  /** Start index of the `/` character. */
  start: number
  /** End index (exclusive) of the trigger token. */
  end: number
  /** The text after the leading `/` (empty string for a lone `/`). */
  filter: string
}

/**
 * Detect a slash-trigger token at any position in the input value.
 *
 * A trigger is a `/` followed by optional non-space characters, where either:
 * - It is at the start of the input, OR
 * - It is preceded by whitespace.
 *
 * This enables mid-text slash menu invocation (e.g. "hello /comp").
 * Returns null when no trigger is found.
 */
export function findSlashTrigger(value: string, caret?: number): SlashTriggerMatch | null {
  // Leading-only fast path (preserves exact original behavior).
  if (isSlashTrigger(value)) {
    return { start: 0, end: value.length, filter: value.slice(1) }
  }
  // Scan for / preceded by whitespace or start-of-string.
  const regex = /(?:^|\s)(\/(\S*))$/g
  let match: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((match = regex.exec(value)) !== null) {
    // Group 1 is the full /token, group 2 is the filter text after /.
    const fullToken = match[1]
    const filter = match[2] ?? ''
    const start = match.index + (match[0].length - fullToken.length)
    const end = start + fullToken.length
    // If a caret position is given, only match if the caret is at or past the token.
    if (caret !== undefined && caret < end) continue
    return { start, end, filter }
  }
  return null
}

/** Extract the filter text from a slash trigger (works with both leading and mid-text). */
export function slashFilter(value: string): string {
  if (isSlashTrigger(value)) return value.slice(1)
  const mid = findSlashTrigger(value)
  return mid ? mid.filter : ''
}

/** True when the input value contains a slash trigger at any position. */
export function isSlashTriggerAny(value: string): boolean {
  return isSlashTrigger(value) || findSlashTrigger(value) !== null
}

/** Replace a leading `/token` with `/<name> ` when a command is chosen. */
export function applyCommandToInput(value: string, commandName: string): string {
  if (isSlashTrigger(value)) {
    return `/${commandName} `
  }
  // Defensive: if somehow not a trigger, append.
  return `${value}/${commandName} `
}
