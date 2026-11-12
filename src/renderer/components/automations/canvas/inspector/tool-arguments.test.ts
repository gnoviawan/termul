import { describe, expect, it } from 'vitest'
import { type ArgumentField, argumentError, argumentFields, setArgument } from './tool-arguments'

describe('argumentFields', () => {
  it('gives one declared type its field, and unions, objects and unknown types the JSON box', () => {
    expect(
      argumentFields({
        type: 'object',
        properties: {
          title: { type: ['string', 'null'] },
          either: { type: ['number', 'boolean'] },
          size: { enum: [1, 2] },
          meta: { type: 'object' },
          free: {},
          odd: true
        },
        required: ['title', 7]
      })
    ).toEqual([
      { name: 'title', kind: 'string', types: ['string', 'null'], required: true },
      { name: 'either', kind: 'json', types: ['number', 'boolean'], required: false },
      { name: 'size', kind: 'enum', types: [], options: ['1', '2'], required: false },
      { name: 'meta', kind: 'json', types: ['object'], required: false },
      { name: 'free', kind: 'string', types: [], required: false },
      { name: 'odd', kind: 'json', types: [], required: false }
    ])
  })

  it.each([
    [null],
    [[]],
    ['object'],
    [{ type: 'object' }],
    [{ properties: {} }]
  ])('has no fields for %j', (schema) => {
    expect(argumentFields(schema)).toBeNull()
  })
})

// `mcp/arguments.rs` `literal_argument`: the first declared type the literal fits wins,
// `string` and unknown types keep it as text, and `null` is taken only for the literal `null`.
describe('argumentError', () => {
  const field = (types: string[], extra: Partial<ArgumentField> = {}): ArgumentField => ({
    name: 'x',
    kind: 'json',
    required: false,
    types,
    ...extra
  })

  it.each([
    [['integer'], '3', null],
    [['integer'], '3.0', 'Not a valid integer'],
    [['integer'], '1e3', 'Not a valid integer'],
    [['integer'], '18446744073709551616', 'Not a valid integer'],
    [['number'], '2.5', null],
    [['number'], 'heavy', 'Not a valid number'],
    [['boolean'], 'true', null],
    [['boolean'], 'True', 'Not a valid boolean'],
    [['array'], '["bug"]', null],
    [['object'], '[1]', 'Not a valid object'],
    [['number', 'boolean'], 'false', null],
    [['number', 'boolean'], 'maybe', 'Not a valid number or boolean'],
    [['integer', 'null'], 'null', null],
    [['integer', 'null'], 'none', 'Not a valid integer or null'],
    [['integer', 'string'], 'anything', null],
    [['date'], 'anything', null],
    [[], 'anything', null]
  ])('%j takes %j: %s', (types, value, error) => {
    expect(argumentError(field(types), value)).toBe(error)
  })

  it('takes any template, and an enum only its listed options', () => {
    expect(argumentError(field(['integer']), '{{ nodes.a.output }}')).toBeNull()
    const kind = field(['string'], { kind: 'enum', options: ['bug', 'feature'] })
    expect(argumentError(kind, 'bug')).toBeNull()
    expect(argumentError(kind, 'chore')).toBe("Not one of the tool's options")
    expect(argumentError(kind, '{{ nodes.a.output }}')).toBeNull()
  })
})

describe('setArgument', () => {
  const args = [
    { name: 'a', value: '1' },
    { name: 'b', value: '2' }
  ]
  it('replaces in place, appends a new one, and drops an emptied one', () => {
    expect(setArgument(args, 'a', '9')).toEqual([
      { name: 'a', value: '9' },
      { name: 'b', value: '2' }
    ])
    expect(setArgument(args, 'c', '3')).toEqual([...args, { name: 'c', value: '3' }])
    expect(setArgument(args, 'a', '')).toEqual([{ name: 'b', value: '2' }])
  })

  it('edits only the first of a repeated name', () => {
    const repeated = [...args, { name: 'a', value: '5' }]
    expect(setArgument(repeated, 'a', '9')).toEqual([
      { name: 'a', value: '9' },
      { name: 'b', value: '2' },
      { name: 'a', value: '5' }
    ])
    expect(setArgument(repeated, 'a', '')).toEqual([
      { name: 'b', value: '2' },
      { name: 'a', value: '5' }
    ])
  })
})
