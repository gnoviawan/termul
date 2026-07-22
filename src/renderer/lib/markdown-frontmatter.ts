import { parse, stringify } from 'yaml'

/** Editable scalar / list values for Properties v1. */
export type FrontmatterScalar = string | number | boolean | null
export type FrontmatterEditableValue = FrontmatterScalar | string[]

/**
 * Nested maps/sequences that are not deep-editable in v1.
 * Preserved through round-trip via `value`; shown via compact `display`.
 */
export interface FrontmatterNested {
  readonly kind: 'nested'
  readonly display: string
  readonly value: unknown
}

export type FrontmatterValue = FrontmatterEditableValue | FrontmatterNested
export type FrontmatterMap = Record<string, FrontmatterValue>

export interface ParsedFrontmatter {
  hasFrontmatter: boolean
  data: FrontmatterMap
  body: string
}

export function isFrontmatterNested(value: FrontmatterValue): value is FrontmatterNested {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as FrontmatterNested).kind === 'nested'
  )
}

function compactYaml(value: unknown): string {
  try {
    return stringify(value, { lineWidth: 0 }).trim()
  } catch {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
}

function wrapNested(value: unknown): FrontmatterNested {
  return {
    kind: 'nested',
    display: compactYaml(value),
    value
  }
}

/** Normalize a raw YAML value into the v1 Properties value model. */
export function normalizeFrontmatterValue(raw: unknown): FrontmatterValue {
  if (raw === null || raw === undefined) {
    return null
  }
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return raw
  }
  if (Array.isArray(raw)) {
    if (raw.every((item) => typeof item === 'string')) {
      return raw as string[]
    }
    return wrapNested(raw)
  }
  if (typeof raw === 'object') {
    return wrapNested(raw)
  }
  return wrapNested(raw)
}

function normalizeMap(raw: Record<string, unknown>): FrontmatterMap {
  const data: FrontmatterMap = {}
  for (const [key, value] of Object.entries(raw)) {
    data[key] = normalizeFrontmatterValue(value)
  }
  return data
}

function toPlainObject(data: FrontmatterMap): Record<string, unknown> {
  const plain: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    plain[key] = isFrontmatterNested(value) ? value.value : value
  }
  return plain
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Detect and split a leading YAML frontmatter block.
 * Invalid YAML between fences or a missing closing fence → no frontmatter
 * (full text returned as body).
 */
export function splitFrontmatter(text: string): ParsedFrontmatter {
  const source = stripBom(text)
  const noFrontmatter: ParsedFrontmatter = {
    hasFrontmatter: false,
    data: {},
    body: text
  }

  const openMatch = /^---\r?\n/.exec(source)
  if (!openMatch) {
    return noFrontmatter
  }

  const yamlStart = openMatch[0].length
  const afterOpen = source.slice(yamlStart)

  let yamlText: string
  let body: string

  const emptyClose = /^---(?:\r?\n|$)/.exec(afterOpen)
  if (emptyClose) {
    yamlText = ''
    body = afterOpen.slice(emptyClose[0].length)
  } else {
    const closeMatch = /\r?\n---(?:\r?\n|$)/.exec(afterOpen)
    if (!closeMatch || closeMatch.index === undefined) {
      return noFrontmatter
    }
    yamlText = afterOpen.slice(0, closeMatch.index)
    body = afterOpen.slice(closeMatch.index + closeMatch[0].length)
  }

  try {
    const trimmed = yamlText.trim()
    if (trimmed === '') {
      return { hasFrontmatter: true, data: {}, body }
    }

    const parsed: unknown = parse(yamlText)
    if (parsed === null || parsed === undefined) {
      return { hasFrontmatter: true, data: {}, body }
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return noFrontmatter
    }

    return {
      hasFrontmatter: true,
      data: normalizeMap(parsed as Record<string, unknown>),
      body
    }
  } catch {
    return noFrontmatter
  }
}

/**
 * Serialize a Properties map to a leading `---` … `---` frontmatter block.
 * Returns `null` when YAML stringify fails so callers can keep last-good content.
 */
export function serializeFrontmatter(data: FrontmatterMap): string | null {
  try {
    const plain = toPlainObject(data)
    const keys = Object.keys(plain)
    if (keys.length === 0) {
      return '---\n---\n'
    }
    const yamlText = stringify(plain, { lineWidth: 0 }).trimEnd()
    return `---\n${yamlText}\n---\n`
  } catch {
    return null
  }
}

/**
 * Rejoin serialized frontmatter with the markdown body.
 * Returns `null` when serialization fails.
 */
export function rejoinFrontmatter(data: FrontmatterMap, body: string): string | null {
  const fm = serializeFrontmatter(data)
  if (fm === null) return null
  return fm + body
}

/**
 * Compose the full editor-store buffer from FM state + body.
 * Returns `null` on serialize failure (caller should keep last-good content).
 */
export function composeFullMarkdown(
  hasFrontmatter: boolean,
  data: FrontmatterMap,
  body: string
): string | null {
  if (!hasFrontmatter) return body
  return rejoinFrontmatter(data, body)
}

/** Format an editable value for a text input. */
export function formatFrontmatterValue(value: FrontmatterEditableValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.join(', ')
  return value
}

/**
 * Parse a committed text-field value into a scalar (or keep as string).
 * Call on blur/commit — not on every keystroke.
 * Leading-zero digit strings (e.g. "007") stay strings.
 */
export function parseScalarInput(text: string): FrontmatterScalar {
  const trimmed = text.trim()
  if (trimmed === 'null') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  // Preserve leading-zero integers as strings ("007"), but allow "0" / "0.5".
  if (/^-?0\d/.test(trimmed)) return text
  if (trimmed !== '' && !Number.isNaN(Number(trimmed)) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed)
  }
  return text
}
