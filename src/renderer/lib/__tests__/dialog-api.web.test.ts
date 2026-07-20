/**
 * Web-branch tests for dialog-api.ts.
 *
 * `selectDirectory` branches on `isTauriContext()`: desktop calls
 * `@tauri-apps/plugin-dialog`'s `open({ directory: true })`; web/remote
 * delegates to a registered opener (the DirectoryPicker component registers
 * itself via `registerWebDirectoryPicker`). If no picker is registered,
 * `selectDirectory` returns a CANCELLED result (graceful fallback).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsTauriContext, mockOpen, mockRegister } = vi.hoisted(() => ({
  mockIsTauriContext: vi.fn(),
  mockOpen: vi.fn(),
  // Captures the opener registered by the (real) dialog-api module so we can
  // assert selectDirectory delegates to it in web mode. We do NOT mock
  // dialog-api itself — we exercise the real module and just spy on its
  // registration hook by replacing the module-internal state.
  mockRegister: vi.fn()
}))

vi.mock('../tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: mockOpen,
  confirm: vi.fn()
}))

import {
  _resetWebDirectoryPickerForTesting,
  dialogApi,
  registerWebDirectoryPicker
} from '../dialog-api'

describe('dialogApi.selectDirectory (web vs desktop branch)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetWebDirectoryPickerForTesting()
  })

  afterEach(() => {
    _resetWebDirectoryPickerForTesting()
  })

  it('delegates to the registered web picker when !isTauriContext()', async () => {
    mockIsTauriContext.mockReturnValue(false)
    registerWebDirectoryPicker(async () => ({
      success: true,
      data: '/web/selected'
    }))

    const result = await dialogApi.selectDirectory()

    expect(result).toEqual({ success: true, data: '/web/selected' })
    // Desktop dialog.open must NOT be called in web mode.
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it('returns CANCELLED when no picker is registered in web mode', async () => {
    mockIsTauriContext.mockReturnValue(false)

    const result = await dialogApi.selectDirectory()

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('CANCELLED')
    }
    expect(mockOpen).not.toHaveBeenCalled()
  })

  it("returns the picker's CANCELLED result transparently", async () => {
    mockIsTauriContext.mockReturnValue(false)
    registerWebDirectoryPicker(async () => ({
      success: false,
      error: 'No directory selected',
      code: 'CANCELLED'
    }))

    const result = await dialogApi.selectDirectory()

    expect(result).toEqual({
      success: false,
      error: 'No directory selected',
      code: 'CANCELLED'
    })
  })

  it('calls dialog.open({ directory: true }) on the desktop path', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockOpen.mockResolvedValueOnce('/desktop/selected')

    const result = await dialogApi.selectDirectory()

    expect(result).toEqual({ success: true, data: '/desktop/selected' })
    expect(mockOpen).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: 'Select Project Folder'
    })
  })

  it('returns CANCELLED when desktop dialog.open resolves null', async () => {
    mockIsTauriContext.mockReturnValue(true)
    mockOpen.mockResolvedValueOnce(null)

    const result = await dialogApi.selectDirectory()

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.code).toBe('CANCELLED')
    }
  })
})

// Silence the unused-import warning for mockRegister while keeping the spy
// available for future assertions on the registration call itself.
void mockRegister
