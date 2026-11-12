/**
 * An agent step's output schema: the JSON Schema subset `schema.rs` takes
 * (`type`, `properties`, `required`, `items`, `enum`, `description`), its
 * parse rules so the editor refuses what the host would, and the edits the
 * editor makes.
 */

import type { JsonSchemaSubset } from '@shared/types/automation.types'

export type SchemaKind = JsonSchemaSubset['type']

export const SCHEMA_KINDS: readonly SchemaKind[] = [
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array'
]

const KEYWORDS = new Set(['type', 'properties', 'required', 'items', 'enum', 'description'])

/** Keywords each kind refuses, as `schema.rs` `reject_keys` does. */
const REJECTED: Record<SchemaKind, readonly string[]> = {
  object: ['items'],
  array: ['properties', 'required'],
  string: ['properties', 'required', 'items'],
  number: ['properties', 'required', 'items'],
  integer: ['properties', 'required', 'items'],
  boolean: ['properties', 'required', 'items']
}

class PathError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function valueKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'object' ? 'object' : typeof value
}

/** `schema::validate`, first mismatch only. */
function mismatch(schema: Record<string, unknown>, value: unknown, path: string): string | null {
  const kind = schema.type as SchemaKind
  const ok =
    kind === 'integer'
      ? Number.isInteger(value)
      : kind === 'number'
        ? typeof value === 'number'
        : valueKind(value) === kind
  if (!ok) return `${path}: expected ${kind}, got ${valueKind(value)}`
  if (Array.isArray(schema.enum) && !schema.enum.some((v) => same(v, value))) {
    return `${path}: ${JSON.stringify(value)} is not one of the allowed values`
  }
  if (kind === 'object' && isObject(value)) {
    const required = (schema.required as string[] | undefined) ?? []
    const missing = required.find((name) => !Object.hasOwn(value, name))
    if (missing !== undefined) return `${path}: missing required property "${missing}"`
    for (const [name, sub] of Object.entries((schema.properties ?? {}) as Record<string, never>)) {
      if (!Object.hasOwn(value, name)) continue
      const inner = mismatch(sub, value[name], `${path}.${name}`)
      if (inner) return inner
    }
  }
  if (kind === 'array' && Array.isArray(value) && isObject(schema.items)) {
    for (const [i, item] of value.entries()) {
      const inner = mismatch(schema.items, item, `${path}[${i}]`)
      if (inner) return inner
    }
  }
  return null
}

/** `serde_json::Value` equality: objects by their members in any order, arrays in order. */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => same(item, b[i]))
    )
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
    )
  }
  return a === b
}

function check(schema: unknown, path: string): void {
  if (!isObject(schema)) throw new PathError(`${path}: schema must be an object`)
  const unknown = Object.keys(schema).find((key) => !KEYWORDS.has(key))
  if (unknown !== undefined) throw new PathError(`${path}: unsupported keyword "${unknown}"`)
  if ('description' in schema && typeof schema.description !== 'string') {
    throw new PathError(`${path}: description must be a string`)
  }
  if (typeof schema.type !== 'string') {
    throw new PathError(`${path}: type is required and must be a string`)
  }
  if (!Object.hasOwn(REJECTED, schema.type)) {
    throw new PathError(`${path}: unsupported type "${schema.type}"`)
  }
  const kind = schema.type as SchemaKind
  const rejected = REJECTED[kind].find((key) => key in schema)
  if (rejected) throw new PathError(`${path}: ${rejected} is not allowed with type "${kind}"`)
  if (kind === 'object') checkObject(schema, path)
  if (kind === 'array' && 'items' in schema) check(schema.items, `${path}.items`)
  if ('enum' in schema) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw new PathError(`${path}: enum must be a non-empty array`)
    }
    const { enum: allowed, ...probe } = schema
    for (const [i, value] of allowed.entries()) {
      const problem = mismatch(probe, value, '$')
      if (problem) {
        throw new PathError(
          `${path}.enum[${i}]: does not match the declared type: ${problem.replace(/^[^:]*: /, '')}`
        )
      }
    }
  }
}

function checkObject(schema: Record<string, unknown>, path: string): void {
  // Absent is no properties; present must be an object, null included.
  const properties = Object.hasOwn(schema, 'properties') ? schema.properties : {}
  if (!isObject(properties)) throw new PathError(`${path}: properties must be an object`)
  for (const [name, sub] of Object.entries(properties)) check(sub, `${path}.properties.${name}`)
  if (!('required' in schema)) return
  if (!Array.isArray(schema.required)) {
    throw new PathError(`${path}: required must be an array of strings`)
  }
  for (const [i, name] of schema.required.entries()) {
    if (typeof name !== 'string') throw new PathError(`${path}.required[${i}]: must be a string`)
    if (!Object.hasOwn(properties, name)) {
      throw new PathError(`${path}.required[${i}]: "${name}" is not declared in properties`)
    }
  }
}

/** `schema::parse`: why the host would refuse `schema`, as it words it, or null. */
export function outputSchemaError(schema: unknown): string | null {
  try {
    check(schema, '$')
    return null
  } catch (error) {
    if (error instanceof PathError) return error.message
    throw error
  }
}

export type SchemaField = { name: string; schema: JsonSchemaSubset; required: boolean }

/** An object schema's fields, in order. */
export function schemaFields(schema: JsonSchemaSubset): SchemaField[] {
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).map(([name, sub]) => ({
    name,
    schema: sub,
    required: required.has(name)
  }))
}

/** An object schema with `fields`, keeping its description and enum. */
export function withFields(
  schema: JsonSchemaSubset,
  fields: readonly SchemaField[]
): JsonSchemaSubset {
  const { properties: _p, required: _r, ...rest } = schema
  const required = fields.filter((field) => field.required).map((field) => field.name)
  return {
    ...rest,
    properties: Object.fromEntries(fields.map((field) => [field.name, field.schema])),
    ...(required.length > 0 ? { required } : {})
  }
}

/** A schema of `kind`; switching kind keeps only the description. */
export function ofKind(kind: SchemaKind, description?: string): JsonSchemaSubset {
  return {
    type: kind,
    ...(kind === 'object' ? { properties: {} } : {}),
    ...(description === undefined ? {} : { description })
  }
}

/** A field name not yet in `fields`: `field`, `field_2`, … */
export function freshFieldName(fields: readonly SchemaField[]): string {
  const taken = new Set(fields.map((field) => field.name))
  if (!taken.has('field')) return 'field'
  let n = 2
  while (taken.has(`field_${n}`)) n += 1
  return `field_${n}`
}

/**
 * `schema` after an edit to its shape. An enum whose values no longer fit
 * the new shape is dropped, since the host refuses the schema with it;
 * `cleared` says so.
 */
export function withoutStaleEnum(schema: JsonSchemaSubset): {
  schema: JsonSchemaSubset
  cleared: boolean
} {
  if (schema.enum === undefined || outputSchemaError(schema) === null) {
    return { schema, cleared: false }
  }
  const { enum: _stale, ...rest } = schema
  return outputSchemaError(rest) === null
    ? { schema: rest, cleared: true }
    : { schema, cleared: false }
}
