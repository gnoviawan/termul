import { MAX_CLIENT_ID_LEN, WS_PROTOCOL_VERSION } from '@shared/types/web-protocol.types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetClientIdentityForTesting,
  buildAuthenticatePayload,
  CLIENT_INSTANCE_ID_STORAGE_KEY,
  DEVICE_ID_STORAGE_KEY,
  ensureClientIdentity,
  getClientInstanceId,
  getDeviceId
} from './web-client-identity'

vi.mock('@/lib/log-api', () => ({ logFrontendError: vi.fn() }))

describe('web-client-identity', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    __resetClientIdentityForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mints a device id once and returns the same value on every call', () => {
    const first = getDeviceId()
    expect(first.length).toBeGreaterThan(0)
    expect(first.length).toBeLessThanOrEqual(MAX_CLIENT_ID_LEN)
    expect(getDeviceId()).toBe(first)
    expect(window.localStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBe(first)
  })

  it('two tabs of one profile share the device id but differ in client instance id', () => {
    const deviceA = getDeviceId()
    const instanceA = getClientInstanceId()

    // A second tab: same localStorage, fresh sessionStorage.
    window.sessionStorage.clear()
    __resetClientIdentityForTesting()
    expect(getDeviceId()).toBe(deviceA)
    const instanceB = getClientInstanceId()
    expect(instanceB).not.toBe(instanceA)
  })

  it('replaces a stored id that exceeds the host byte limit', () => {
    // 100 two-byte characters: 100 UTF-16 units but 200 UTF-8 bytes.
    const tooLong = '\u00e9'.repeat(100)
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, tooLong)
    const device = getDeviceId()
    expect(device).not.toBe(tooLong)
    expect(new TextEncoder().encode(device).length).toBeLessThanOrEqual(MAX_CLIENT_ID_LEN)
  })

  it('replaces a stored id that contains control characters', () => {
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, 'device\nforged log line')
    const device = getDeviceId()
    expect(device).not.toContain('\n')
    expect(window.localStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBe(device)
  })

  it('adopts the persisted device id when a concurrent tab wrote first', () => {
    const winner = 'winner-device-id'
    const realSet = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      // The other tab's write lands after our mint, before our re-read.
      realSet.call(this, key, key === DEVICE_ID_STORAGE_KEY ? winner : value)
    })
    expect(getDeviceId()).toBe(winner)
  })

  it('a reload of one tab keeps its client instance id', () => {
    const instance = getClientInstanceId()
    window.dispatchEvent(new Event('pagehide'))
    __resetClientIdentityForTesting() // fresh module state, same sessionStorage
    expect(getClientInstanceId()).toBe(instance)
    expect(window.sessionStorage.getItem(CLIENT_INSTANCE_ID_STORAGE_KEY)).toBe(instance)
  })

  it('a duplicated tab, which copies sessionStorage while the original lives, gets its own id', () => {
    const original = getClientInstanceId()
    __resetClientIdentityForTesting() // a second page with a copy of the same sessionStorage
    const duplicate = getClientInstanceId()
    expect(duplicate).not.toBe(original)
    expect(getClientInstanceId()).toBe(duplicate)
    expect(window.sessionStorage.getItem(CLIENT_INSTANCE_ID_STORAGE_KEY)).toBe(duplicate)
  })

  it('a page made from a copy of a released id gets its own once the reload took it', () => {
    const instance = getClientInstanceId()
    window.dispatchEvent(new Event('pagehide'))
    const copied = { ...window.sessionStorage }

    __resetClientIdentityForTesting() // the reload
    expect(getClientInstanceId()).toBe(instance)

    window.sessionStorage.clear() // a duplicate made before the reload ran
    for (const [key, value] of Object.entries(copied)) window.sessionStorage.setItem(key, value)
    __resetClientIdentityForTesting()
    expect(getClientInstanceId()).not.toBe(instance)
  })

  it('a duplicate of a page now back from the back-forward cache gets its own id', () => {
    const instance = getClientInstanceId()
    window.dispatchEvent(new Event('pagehide'))
    const copied = { ...window.sessionStorage }
    const shown = new Event('pageshow')
    Object.defineProperty(shown, 'persisted', { value: true })
    window.dispatchEvent(shown)

    window.sessionStorage.clear()
    for (const [key, value] of Object.entries(copied)) window.sessionStorage.setItem(key, value)
    __resetClientIdentityForTesting()
    expect(getClientInstanceId()).not.toBe(instance)
  })

  it('a page back from the back-forward cache holds its id again', () => {
    const instance = getClientInstanceId()
    window.dispatchEvent(new Event('pagehide'))
    const shown = new Event('pageshow')
    Object.defineProperty(shown, 'persisted', { value: true })
    window.dispatchEvent(shown)
    __resetClientIdentityForTesting()
    expect(getClientInstanceId()).not.toBe(instance)
  })

  it('replaces a corrupt (empty or oversized) stored id with a fresh valid one', () => {
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, 'x'.repeat(MAX_CLIENT_ID_LEN + 1))
    window.sessionStorage.setItem(CLIENT_INSTANCE_ID_STORAGE_KEY, '')
    const device = getDeviceId()
    const instance = getClientInstanceId()
    expect(device.length).toBeLessThanOrEqual(MAX_CLIENT_ID_LEN)
    expect(instance.length).toBeGreaterThan(0)
    expect(window.localStorage.getItem(DEVICE_ID_STORAGE_KEY)).toBe(device)
  })

  it('keeps one stable in-memory identity for the page when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })
    const device = getDeviceId()
    const instance = getClientInstanceId()
    expect(device).not.toBe(instance)
    expect(getDeviceId()).toBe(device)
    expect(getClientInstanceId()).toBe(instance)
    expect(buildAuthenticatePayload().deviceId).toBe(device)
  })

  it('ensureClientIdentity mints both ids so later handshakes reuse them', () => {
    ensureClientIdentity()
    const device = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY)
    const instance = window.sessionStorage.getItem(CLIENT_INSTANCE_ID_STORAGE_KEY)
    expect(device).toBeTruthy()
    expect(instance).toBeTruthy()
    expect(buildAuthenticatePayload('t')).toEqual({
      protocolVersion: WS_PROTOCOL_VERSION,
      deviceId: device,
      clientInstanceId: instance,
      token: 't'
    })
  })

  it('omits the token key entirely when no token is supplied', () => {
    for (const none of [undefined, null, '']) {
      const payload = buildAuthenticatePayload(none)
      expect('token' in payload).toBe(false)
      expect(payload.protocolVersion).toBe(WS_PROTOCOL_VERSION)
    }
  })
})
