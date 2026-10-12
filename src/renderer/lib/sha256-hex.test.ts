import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './sha256-hex'

describe('sha256Hex', () => {
  it.each([
    '',
    'abc',
    'é'.repeat(100),
    'x'.repeat(55),
    'x'.repeat(56),
    'x'.repeat(64),
    'x'.repeat(1000)
  ])('matches node crypto for %#', (input) => {
    expect(sha256Hex(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'))
  })
})
