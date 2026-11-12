import { describe, expect, it } from 'vitest'
import { argumentFields, setArgument } from './tool-arguments'

describe('argumentFields', () => {
  it('reads nullable types, scalar enums, and anything else as JSON', () => {
    expect(
      argumentFields({
        type: 'object',
        properties: {
          title: { type: ['string', 'null'] },
          size: { enum: [1, 2] },
          meta: { type: 'object' },
          odd: true
        },
        required: ['title', 7]
      })
    ).toEqual([
      { name: 'title', kind: 'string', required: true },
      { name: 'size', kind: 'enum', options: ['1', '2'], required: false },
      { name: 'meta', kind: 'json', required: false },
      { name: 'odd', kind: 'json', required: false }
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
})
