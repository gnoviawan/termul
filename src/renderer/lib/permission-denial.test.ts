import { describe, expect, it } from 'vitest'
import { permissionDeniedMessage, permissionToolTitle } from './permission-denial'

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

describe('permissionDeniedMessage', () => {
  it('names the tool with the adopted copy', () => {
    expect(permissionDeniedMessage('npm test -- auth')).toBe(
      'Permission for npm test -- auth was denied because this device disconnected. Ask the agent to retry.'
    )
  })

  it('reads sensibly for the generic fallback', () => {
    expect(permissionDeniedMessage('this action')).toBe(
      'Permission for this action was denied because this device disconnected. Ask the agent to retry.'
    )
  })
})
