import { describe, expect, it } from 'vitest'
import { outputSchemaError, schemaFields, withFields, withoutStaleEnum } from './output-schema'

// Messages follow `schema.rs` `parse`, which the host words as `output_schema <path>: <message>`.
describe('outputSchemaError', () => {
  it.each([
    [{ type: 'string' }],
    [{ type: 'object' }],
    [
      {
        type: 'object',
        properties: { summary: { type: 'string' }, urgent: { type: 'boolean' } },
        required: ['summary', 'urgent']
      }
    ],
    [{ type: 'array', items: { type: 'integer', enum: [1, 2] } }],
    [{ type: 'string', enum: ['bug', 'feature'], description: 'The label' }],
    [
      {
        type: 'object',
        properties: { p: { type: 'object', enum: [{ x: 1, y: 2 }] } },
        enum: [{ p: { y: 2, x: 1 } }]
      }
    ]
  ])('takes %j', (schema) => {
    expect(outputSchemaError(schema)).toBeNull()
  })

  it.each([
    [[], '$: schema must be an object'],
    [{ type: 'string', format: 'email' }, '$: unsupported keyword "format"'],
    [{ properties: {} }, '$: type is required and must be a string'],
    [{ type: 'null' }, '$: unsupported type "null"'],
    [{ type: 'toString' }, '$: unsupported type "toString"'],
    [{ type: 'object', properties: null }, '$: properties must be an object'],
    [
      { type: 'object', properties: {}, required: ['constructor'] },
      '$.required[0]: "constructor" is not declared in properties'
    ],
    [
      { type: 'object', properties: { a: { type: 'string' } }, enum: [{ a: 1 }] },
      '$.enum[0]: does not match the declared type: expected string, got number'
    ],
    [{ type: 'string', items: { type: 'string' } }, '$: items is not allowed with type "string"'],
    [{ type: 'array', required: [] }, '$: required is not allowed with type "array"'],
    [{ type: 'object', items: {} }, '$: items is not allowed with type "object"'],
    [{ type: 'string', description: 3 }, '$: description must be a string'],
    [
      { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] },
      '$.required[0]: "b" is not declared in properties'
    ],
    [
      { type: 'object', properties: { a: { type: 'date' } } },
      '$.properties.a: unsupported type "date"'
    ],
    [{ type: 'array', items: { type: 'string', x: 1 } }, '$.items: unsupported keyword "x"'],
    [{ type: 'string', enum: [] }, '$: enum must be a non-empty array'],
    [
      { type: 'integer', enum: [1, 1.5] },
      '$.enum[1]: does not match the declared type: expected integer, got number'
    ]
  ])('refuses %j', (schema, message) => {
    expect(outputSchemaError(schema)).toBe(message)
  })
})

describe('schema fields', () => {
  it('round-trips an object schema through its fields and keeps its description', () => {
    const schema = {
      type: 'object' as const,
      description: 'A label',
      properties: { label: { type: 'string' as const }, score: { type: 'number' as const } },
      required: ['label']
    }
    const fields = schemaFields(schema)
    expect(fields).toEqual([
      { name: 'label', schema: { type: 'string' }, required: true },
      { name: 'score', schema: { type: 'number' }, required: false }
    ])
    expect(withFields(schema, fields)).toEqual(schema)
    expect(withFields(schema, [{ ...fields[1], required: false }])).toEqual({
      type: 'object',
      description: 'A label',
      properties: { score: { type: 'number' } }
    })
  })
})

describe('withoutStaleEnum', () => {
  it('drops an enum the new shape no longer fits, and keeps one that still fits', () => {
    const fits = {
      type: 'object' as const,
      properties: { a: { type: 'string' as const } },
      enum: [{ a: 'x' }]
    }
    expect(withoutStaleEnum(fits)).toEqual({ schema: fits, cleared: false })
    const required = {
      ...fits,
      required: ['a', 'b'],
      properties: { ...fits.properties, b: { type: 'string' as const } }
    }
    expect(withoutStaleEnum(required)).toEqual({
      schema: { type: 'object', properties: required.properties, required: ['a', 'b'] },
      cleared: true
    })
  })
})
