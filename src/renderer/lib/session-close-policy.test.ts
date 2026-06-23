import { describe, expect, it } from 'vitest'
import { getSessionClosePolicy } from './session-close-policy'

describe('getSessionClosePolicy', () => {
  it('requires prompt when live terminals exist', () => {
    expect(getSessionClosePolicy([{ status: 'running' }])).toBe('prompt')
  })

  it('requires prompt when detached sessions exist', () => {
    expect(getSessionClosePolicy([{ status: 'detached' }])).toBe('prompt')
  })

  it('allows close when no live sessions exist', () => {
    expect(getSessionClosePolicy([{ status: 'exited' }, { status: 'lost' }])).toBe('close')
  })
})
