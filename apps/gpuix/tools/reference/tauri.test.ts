import { describe, expect, test } from 'bun:test'
import { withHostLocalCredential } from '../matrix/host-local'
import { x11Keys } from './tauri'

describe('desktop app input', () => {
  test('GPUI keystrokes become X keysym combinations', () => {
    expect(x11Keys('ctrl-shift-n')).toBe('Control_L+Shift_L+n')
    expect(x11Keys('ctrl-,')).toBe('Control_L+comma')
    expect(x11Keys('ctrl-=')).toBe('Control_L+equal')
    expect(x11Keys('enter')).toBe('Return')
  })
})

describe('web-host-local reference', () => {
  test('only an authenticate frame gains the credential', () => {
    const auth = JSON.stringify({ id: 'r1', type: 'authenticate', payload: { deviceId: 'd' } })
    expect(JSON.parse(withHostLocalCredential(auth, 'secret'))).toEqual({
      id: 'r1',
      type: 'authenticate',
      payload: { deviceId: 'd', hostLocalToken: 'secret' }
    })
    const other = JSON.stringify({ id: 'r2', type: 'store_read', payload: { key: 'k' } })
    expect(withHostLocalCredential(other, 'secret')).toBe(other)
    expect(withHostLocalCredential('not json', 'secret')).toBe('not json')
  })
})
