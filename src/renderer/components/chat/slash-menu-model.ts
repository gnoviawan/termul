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
import { dropDuplicateSingletonConfigOptions } from './chat-input-bar-config'

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
  /** Absolute `SKILL.md` path, captured at pick time so the composer can record
   * it for the wire prompt without an IPC read at send. */
  path: string
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

/** Prefix agents use when re-promoting a discovered skill as a command
 * (`skill:<name>`, e.g. Devin). */
const PROMOTED_SKILL_COMMAND_PREFIX = 'skill:'

/** Strip the agent skill-promotion prefix, if present. Case-insensitive on
 * the prefix (agent command names are unconstrained); the suffix is trimmed
 * and lowercased for comparison against validated-lowercase skill names. */
function promotedSkillName(name: string): string | null {
  if (!name.toLowerCase().startsWith(PROMOTED_SKILL_COMMAND_PREFIX)) return null
  const suffix = name.slice(PROMOTED_SKILL_COMMAND_PREFIX.length).trim().toLowerCase()
  return suffix || null
}

/**
 * Build ordered menu sections from the active session's ACP state.
 *
 * Order: Skills first, then Commands, then each config option as its own
 * section (preserving the agent's array order). When `configOptions` is
 * non-empty, the legacy `modes` section is omitted entirely (precedence).
 * When it is empty, a single legacy Modes section is emitted if modes exist.
 */
export function buildSlashSections(input: SlashMenuInput): SlashSection[] {
  const { commands, configOptions, modes, skills = [], filter } = input
  const sections: SlashSection[] = []

  // First-wins dedupe for promoted singleton categories (#444): a duplicate
  // `thought_level`/`model` option must not emit a second "Thinking Level"/
  // "Model" section next to the promoted chip's section.
  const dedupedConfigOptions = dropDuplicateSingletonConfigOptions(configOptions)

  // Dedupes below run against the post-filter lists so a row hidden by the
  // text filter can never suppress the only visible row for a name.
  const visibleCommands = commands.filter((c) => matches(filter, c.name, c.description))
  const visibleSkills = skills.filter((s) => matches(filter, s.name, s.description))

  // Dedup against the agent's ACP commands: when a skill shares a name with
  // a command the agent already surfaces natively, the command wins and the
  // skill is hidden so the same name never appears twice. Skills the agent
  // does NOT surface are still listed (fixes the post-#506 "skills missing").
  const commandNames = new Set(visibleCommands.map((c) => c.name))
  const skillItems: SlashItem[] = visibleSkills
    .filter((s) => !commandNames.has(s.name))
    .map((s) => ({
      kind: 'skill',
      name: s.name,
      description: s.description || null,
      scope: s.scope,
      path: s.path
    }))
  if (skillItems.length > 0) {
    sections.push({ id: 'skills', heading: 'Skills', items: skillItems })
  }

  // Reverse dedup for agent-promoted skill commands (`skill:<name>`): the
  // injected termul skill item is first class, so the mirrored command is
  // hidden and the name appears once (Skills). Built from the RETAINED skill
  // items — a `skill:` mirror stays listed when its skill was suppressed by
  // the forward dedupe or names an agent-only skill termul never discovered.
  const injectedSkillNames = new Set(skillItems.map((s) => (s.kind === 'skill' ? s.name : '')))
  const commandItems: SlashItem[] = visibleCommands
    .filter((c) => {
      const promoted = promotedSkillName(c.name)
      return promoted === null || !injectedSkillNames.has(promoted)
    })
    .map((c) => ({ kind: 'command', name: c.name, description: c.description ?? null }))
  if (commandItems.length > 0) {
    sections.push({ id: 'commands', heading: 'Commands', items: commandItems })
  }

  if (dedupedConfigOptions.length > 0) {
    for (const option of dedupedConfigOptions) {
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
 * Detect the slash token that contains the caret.
 *
 * The token is a `/` plus the following non-space characters. The character
 * before that `/` is the start of the text, a space, or a line break. Text
 * after the token does not hide the menu. A `/` inside a word does not match.
 * When `caret` is omitted, the caret is the end of `value`.
 */
export function findSlashTrigger(
  value: string,
  caret: number = value.length
): SlashTriggerMatch | null {
  if (caret <= 0 || caret > value.length) return null
  const previous = value[caret - 1]
  if (previous === undefined || /\s/.test(previous)) return null
  let start = caret - 1
  while (start > 0 && !/\s/.test(value[start - 1] ?? '')) start -= 1
  if (value[start] !== '/') return null
  if (caret <= start) return null
  return { start, end: caret, filter: value.slice(start + 1, caret) }
}

/** Extract the filter text from the slash token at the caret. */
export function slashFilter(value: string, caret?: number): string {
  return findSlashTrigger(value, caret)?.filter ?? ''
}

/** True when the caret sits in a slash token. */
export function isSlashTriggerAny(value: string, caret?: number): boolean {
  return findSlashTrigger(value, caret) !== null
}

/** Replace a leading `/token` with `/<name> ` when a command is chosen. */
export function applyCommandToInput(value: string, commandName: string): string {
  if (isSlashTrigger(value)) {
    return `/${commandName} `
  }
  // Defensive: if somehow not a trigger, append.
  return `${value}/${commandName} `
}
