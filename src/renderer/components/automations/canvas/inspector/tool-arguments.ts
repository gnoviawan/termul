/**
 * An MCP tool's arguments as form fields, read from its `inputSchema`, and
 * the edits those fields make to an mcp_tool step's `arguments`.
 *
 * Every argument is a template (`model.rs` `McpTool::arguments`). A value
 * that is one whole `{{ }}` keeps the JSON type of what it reads; a literal
 * is typed by the property's declared `type` (`mcp/arguments.rs`
 * `literal_argument`), so a typed field still stores text.
 */

import type { NamedTemplate } from '@shared/types/automation.types'

export type ArgumentKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json'

export type ArgumentField = {
  name: string
  kind: ArgumentKind
  required: boolean
  /** The declared `type`, as a list: what the host parses a literal into. */
  types: string[]
  description?: string
  /** An enum's values, as the text the field stores. */
  options?: string[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `literal_argument`'s reading of `type`: one name, or the names in a list. */
function typesOf(schema: Record<string, unknown>): string[] {
  if (typeof schema.type === 'string') return [schema.type]
  return Array.isArray(schema.type)
    ? schema.type.filter((type): type is string => typeof type === 'string')
    : []
}

const SCALAR_KINDS = new Set<ArgumentKind>(['string', 'number', 'integer', 'boolean'])

/**
 * One declared type, alone or beside `null`, gets that type's field. A
 * union of more types, objects, arrays and unknown types get the JSON box.
 */
function kindOf(schema: Record<string, unknown>, types: string[]): ArgumentField['kind'] {
  const scalar = (value: unknown) => ['string', 'number', 'boolean'].includes(typeof value)
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(scalar)) {
    return 'enum'
  }
  const declared = types.filter((type) => type !== 'null')
  if (declared.length === 0) return 'string'
  const [only] = declared
  return declared.length === 1 && SCALAR_KINDS.has(only as ArgumentKind)
    ? (only as ArgumentKind)
    : 'json'
}

/** The fields of an object `inputSchema` in its order; null when it declares none. */
export function argumentFields(inputSchema: unknown): ArgumentField[] | null {
  if (!isObject(inputSchema) || !isObject(inputSchema.properties)) return null
  const required = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((name) => typeof name === 'string')
      : []
  )
  const fields = Object.entries(inputSchema.properties).map(([name, raw]): ArgumentField => {
    const schema = isObject(raw) ? raw : {}
    const types = typesOf(schema)
    const kind = isObject(raw) ? kindOf(schema, types) : 'json'
    return {
      name,
      kind,
      required: required.has(name),
      types,
      ...(kind === 'enum' ? { options: (schema.enum as unknown[]).map(String) } : {}),
      ...(typeof schema.description === 'string' ? { description: schema.description } : {})
    }
  })
  return fields.length > 0 ? fields : null
}

/** Whether the tool takes arguments its schema does not name. */
export function takesOtherArguments(inputSchema: unknown): boolean {
  return !isObject(inputSchema) || inputSchema.additionalProperties !== false
}

/**
 * `args` with the first `name` set to `value`, in place when it is there,
 * else at the end. An empty value removes it, so an unset one is not sent.
 * A repeat of the name is left as it is.
 */
export function setArgument(
  args: readonly NamedTemplate[],
  name: string,
  value: string
): NamedTemplate[] {
  const at = args.findIndex((arg) => arg.name === name)
  if (at < 0) return value === '' ? [...args] : [...args, { name, value }]
  return value === ''
    ? args.filter((_, i) => i !== at)
    : args.map((arg, i) => (i === at ? { ...arg, value } : arg))
}

export const isTemplate = (value: string): boolean => value.includes('{{')

const I64_MIN = -(2n ** 63n)
const U64_MAX = 2n ** 64n - 1n

/** `fit`: whether `text` parses into JSON of type `type`; undefined for a type kept as text. */
function fits(type: string, text: string): boolean | undefined {
  const parse = (): unknown => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }
  switch (type) {
    case 'boolean':
      return typeof parse() === 'boolean'
    case 'number': {
      const value = parse()
      return typeof value === 'number' && Number.isFinite(value)
    }
    case 'integer': {
      // serde_json reads only a whole number with no fraction or exponent as an integer.
      const whole = text.trim()
      if (!/^-?(0|[1-9]\d*)$/.test(whole)) return false
      const n = BigInt(whole)
      return n >= I64_MIN && n <= U64_MAX
    }
    case 'object':
      return isObject(parse())
    case 'array':
      return Array.isArray(parse())
    default:
      return undefined
  }
}

/**
 * Why the host refuses the literal `value` for `field`, or null. A template
 * is checked when it renders; an empty value is not sent.
 */
export function argumentError(field: ArgumentField, value: string): string | null {
  if (value === '' || isTemplate(value)) return null
  if (field.kind === 'enum' && !field.options?.includes(value)) {
    return "Not one of the tool's options"
  }
  if (field.types.length === 0) return null
  if (field.types.includes('null') && value === 'null') return null
  for (const type of field.types.filter((t) => t !== 'null')) {
    const fit = fits(type, value)
    if (fit !== false) return null
  }
  return `Not a valid ${field.types.join(' or ')}`
}
