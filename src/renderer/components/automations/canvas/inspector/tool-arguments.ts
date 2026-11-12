/**
 * An MCP tool's arguments as form fields, read from its `inputSchema`, and
 * the edits those fields make to an mcp_tool step's `arguments`.
 *
 * Every argument is a template (`model.rs` `McpTool::arguments`). The host
 * renders a value that is one whole `{{ }}` with its JSON type and anything
 * else as a string, so a typed field still stores text.
 */

import type { NamedTemplate } from '@shared/types/automation.types'

export type ArgumentKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'json'

export type ArgumentField = {
  name: string
  kind: ArgumentKind
  required: boolean
  description?: string
  /** An enum's values, as the text the field stores. */
  options?: string[]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `["string", "null"]` reads as `string`. */
function typeOf(schema: Record<string, unknown>): unknown {
  return Array.isArray(schema.type) ? schema.type.find((type) => type !== 'null') : schema.type
}

function kindOf(schema: Record<string, unknown>): Pick<ArgumentField, 'kind' | 'options'> {
  const scalar = (value: unknown) => ['string', 'number', 'boolean'].includes(typeof value)
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(scalar)) {
    return { kind: 'enum', options: schema.enum.map(String) }
  }
  const type = typeOf(schema)
  return type === 'string' || type === 'number' || type === 'integer' || type === 'boolean'
    ? { kind: type }
    : { kind: 'json' }
}

/** The fields of an object `inputSchema` in its order; null when it declares none. */
export function argumentFields(inputSchema: unknown): ArgumentField[] | null {
  if (!isObject(inputSchema) || !isObject(inputSchema.properties)) return null
  const required = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((name) => typeof name === 'string')
      : []
  )
  const fields = Object.entries(inputSchema.properties).map(([name, schema]) => ({
    name,
    required: required.has(name),
    ...(isObject(schema) ? kindOf(schema) : { kind: 'json' as const }),
    ...(isObject(schema) && typeof schema.description === 'string'
      ? { description: schema.description }
      : {})
  }))
  return fields.length > 0 ? fields : null
}

/**
 * `args` with `name` set to `value`, in place when it is there, else at the
 * end. An empty value removes the argument, so an unset one is not sent.
 */
export function setArgument(args: readonly NamedTemplate[], name: string, value: string) {
  if (value === '') return args.filter((arg) => arg.name !== name)
  return args.some((arg) => arg.name === name)
    ? args.map((arg) => (arg.name === name ? { ...arg, value } : arg))
    : [...args, { name, value }]
}

export const isTemplate = (value: string): boolean => value.includes('{{')

/** Why the host could not read `value` as `kind`, or null. A template is checked when it renders. */
export function argumentError(kind: ArgumentKind, value: string): string | null {
  const text = value.trim()
  if (text === '' || isTemplate(text)) return null
  if (kind === 'number' && !Number.isFinite(Number(text))) return 'Enter a number'
  if (kind === 'integer' && !Number.isInteger(Number(text))) return 'Enter a whole number'
  if (kind === 'json') {
    try {
      JSON.parse(text)
    } catch {
      return 'Not valid JSON'
    }
  }
  return null
}
