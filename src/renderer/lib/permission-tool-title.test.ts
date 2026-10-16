import { describe, expect, it } from 'vitest'
import { permissionToolTitle } from './permission-tool-title'

describe('permissionToolTitle', () => {
  it('prefers the tool call title, then its id, then a generic phrase', () => {
    expect(permissionToolTitle({ title: 'npm test -- auth', toolCallId: 'tc-1' })).toBe(
      'npm test -- auth'
    )
    expect(permissionToolTitle({ toolCallId: 'tc-1' })).toBe('tc-1')
    expect(permissionToolTitle({})).toBe('this action')
  })

  it('falls back for a missing or non-object tool call', () => {
    expect(permissionToolTitle(null)).toBe('this action')
    expect(permissionToolTitle(undefined)).toBe('this action')
    expect(permissionToolTitle('Run it')).toBe('this action')
  })
})
