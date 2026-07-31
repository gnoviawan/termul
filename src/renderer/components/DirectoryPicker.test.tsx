import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFetch, mockIsTauriContext, registeredPicker } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockIsTauriContext: vi.fn(),
  // Captured by the dialog-api mock when DirectoryPicker mounts; the test
  // invokes it the same way `dialogApi.selectDirectory()` would in web mode.
  registeredPicker: { current: null as null | (() => Promise<unknown>) }
}))

vi.mock('@/lib/tauri-runtime', () => ({
  isTauriContext: mockIsTauriContext
}))

vi.mock('@/lib/dialog-api', () => ({
  registerWebDirectoryPicker: (opener: () => Promise<unknown>) => {
    registeredPicker.current = opener
  },
  _resetWebDirectoryPickerForTesting: () => {
    registeredPicker.current = null
  }
}))

import { __testing, DirectoryPicker } from './DirectoryPicker'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body)
  } as unknown as Response
}

function dirEntry(name: string, path: string): unknown {
  return {
    name,
    path,
    type: 'directory',
    extension: null,
    size: 0,
    modifiedAt: 0
  }
}

function fileEntry(name: string, path: string): unknown {
  return {
    name,
    path,
    type: 'file',
    extension: '.txt',
    size: 10,
    modifiedAt: 0
  }
}

/** Open the picker by invoking the registered opener (mimics dialogApi.selectDirectory). Returns the opener's promise so the test can await its resolution after interacting with the modal. */
function openPicker(): Promise<unknown> {
  if (!registeredPicker.current) {
    throw new Error('picker not registered')
  }
  // Fire the opener; it returns a promise that resolves when the user selects
  // or cancels. We do NOT await it here — the modal's async listing work runs
  // concurrently and is observed via waitFor below.
  return registeredPicker.current()
}

describe('DirectoryPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredPicker.current = null
    mockIsTauriContext.mockReturnValue(false)
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    registeredPicker.current = null
  })

  it('does not register a picker in Tauri (desktop) context', async () => {
    mockIsTauriContext.mockReturnValue(true)
    render(<DirectoryPicker />)
    await waitFor(() => {
      expect(registeredPicker.current).toBeNull()
    })
  })

  it('registers its opener with dialogApi on mount in web mode', async () => {
    render(<DirectoryPicker />)
    await waitFor(() => {
      expect(registeredPicker.current).not.toBeNull()
    })
  })

  describe('when opened', () => {
    it('lists directories from /fs/browse (files filtered out)', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [
            dirEntry('src', '/root/src'),
            fileEntry('readme.txt', '/root/readme.txt'),
            dirEntry('docs', '/root/docs')
          ]
        })
      )

      render(<DirectoryPicker />)
      await waitFor(() => expect(registeredPicker.current).not.toBeNull())

      // Invoke the registered opener (mimics dialogApi.selectDirectory()).
      const promise = openPicker()

      // Initial listing loaded.
      await waitFor(() => {
        expect(screen.getByText('src')).toBeInTheDocument()
        expect(screen.getByText('docs')).toBeInTheDocument()
      })
      // Files are filtered out (dirs-only folder picker UX).
      expect(screen.queryByText('readme.txt')).not.toBeInTheDocument()

      // Cancel — resolves with CANCELLED so the opener promise settles.
      fireEvent.click(screen.getByText('Cancel'))
      const result = await promise
      expect(result).toEqual({
        success: false,
        error: 'No directory selected',
        code: 'CANCELLED'
      })
    })

    it('navigates into a subdirectory by re-calling /fs/browse', async () => {
      // First open: root listing.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [dirEntry('projects', '/root/projects')]
        })
      )
      // Second call: descending into /root/projects.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [dirEntry('my-app', '/root/projects/my-app')]
        })
      )

      render(<DirectoryPicker />)
      await waitFor(() => expect(registeredPicker.current).not.toBeNull())

      const promise = openPicker()

      await waitFor(() => expect(screen.getByText('projects')).toBeInTheDocument())

      // Descend into "projects".
      fireEvent.click(screen.getByText('projects'))

      await waitFor(() => {
        expect(screen.getByText('my-app')).toBeInTheDocument()
      })

      // The second fetch targeted the child path with the encoded query.
      const secondCall = mockFetch.mock.calls[1]?.[0]
      expect(secondCall).toContain('/fs/browse?path=')
      expect(secondCall).toContain(encodeURIComponent('/root/projects'))

      // Cancel to settle the opener promise.
      fireEvent.click(screen.getByText('Cancel'))
      await promise
    })

    it('ascends with the "Up" affordance (go up)', async () => {
      // Open at /root/projects.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, data: [dirEntry('my-app', '/root/projects/my-app')] })
      )
      // Go-up fetch returns /root's children.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, data: [dirEntry('projects', '/root/projects')] })
      )

      render(<DirectoryPicker />)
      await waitFor(() => expect(registeredPicker.current).not.toBeNull())

      const promise = openPicker()

      await waitFor(() => expect(screen.getByText('my-app')).toBeInTheDocument())

      // The path bar shows the current path.
      expect(screen.getByText('/root/projects')).toBeInTheDocument()

      // Click "Up".
      fireEvent.click(screen.getByRole('button', { name: 'Go up one directory' }))

      await waitFor(() => {
        // We ascended to /root and see "projects" again.
        expect(screen.getByText('projects')).toBeInTheDocument()
      })

      // The go-up fetch targeted the parent path.
      const upCall = mockFetch.mock.calls[1]?.[0]
      expect(upCall).toContain(encodeURIComponent('/root'))

      fireEvent.click(screen.getByText('Cancel'))
      await promise
    })

    it('selects the current folder and resolves the opener with its path', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, data: [dirEntry('sub', '/root/sub')] })
      )

      render(<DirectoryPicker />)
      await waitFor(() => expect(registeredPicker.current).not.toBeNull())

      const promise = openPicker()

      await waitFor(() => expect(screen.getByText('sub')).toBeInTheDocument())

      // Select the current folder (/root in this case).
      fireEvent.click(screen.getByText('Select Current Folder'))

      const result = await promise
      expect(result).toEqual({ success: true, data: '/root' })
    })

    it('shows a server failure message but keeps the seeded path (Patch A: non-empty initial)', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: false, error: 'not found', code: 'READ_ERROR' })
      )

      render(<DirectoryPicker />)
      await waitFor(() => expect(registeredPicker.current).not.toBeNull())

      const promise = openPicker()

      await waitFor(() => {
        expect(screen.getByText('not found')).toBeInTheDocument()
      })

      // Patch A: the initial path is now the host root (C:\ on Windows),
      // NOT the empty string. So after a listing failure the path bar still
      // shows the seeded root and "Select Current Folder" is enabled — the
      // user is no longer stuck (the original AC failure). On non-Windows CI
      // the seed is `/`; either way the bar is non-empty.
      const selectBtn = screen.getByText('Select Current Folder')
      expect(selectBtn.closest('button')).not.toBeDisabled()

      // Cancel to settle.
      fireEvent.click(screen.getByText('Cancel'))
      await promise
    })

    // Patch A: the picker seeds with a non-empty initial path (the host
    // filesystem root — `C:\` on Windows, `/` on POSIX) so the first browse
    // succeeds and the picker actually reaches a browsable state — not just
    // the error path the old empty-string default exercised. This asserts the
    // AC ("a directory picker opens listing host directories") directly.
    it('reaches a browsable state on first open (Patch A: non-empty initial path)', async () => {
      // Entries are platform-agnostic in shape; the derive-from-entries
      // logic sets the path bar to the parent of the first entry's path.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [
            dirEntry('Users', 'C:/Users'),
            dirEntry('Program Files', 'C:/Program Files'),
            dirEntry('Windows', 'C:/Windows')
          ]
        })
      )

      render(<DirectoryPicker />)
      await waitFor(() => expect(registeredPicker.current).not.toBeNull())

      const promise = openPicker()

      // The initial browse targeted a NON-empty path (the host root), NOT
      // the empty query string the pre-Patch-A default produced. The path is
      // platform-dependent (`C:\` on Win32 jsdom, `/` on Linux jsdom) —
      // either way it must NOT be empty.
      const firstCall = String(mockFetch.mock.calls[0]?.[0] ?? '')
      expect(firstCall).toMatch(/\/fs\/browse\?path=/)
      // The path query param is non-empty (the encoded value is not "").
      const match = firstCall.match(/[?&]path=([^&]*)$/)
      expect(match, 'path query param present').toBeTruthy()
      expect(match![1], 'path must be non-empty (not the bare empty default)').not.toBe('')

      // Entries render — the picker is in a browsable state, not stuck on
      // an ENOENT error (the original AC failure: empty path → read_dir
      // ENOENT → picker dead, Select/Up disabled).
      await waitFor(() => {
        expect(screen.getByText('Users')).toBeInTheDocument()
        expect(screen.getByText('Windows')).toBeInTheDocument()
      })

      // The path bar shows the derived current path (parent of C:/Users).
      expect(screen.getByText('C:/')).toBeInTheDocument()

      fireEvent.click(screen.getByText('Cancel'))
      await promise
    })

    it('cancels on Escape key', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }))

      render(<DirectoryPicker />)
      await waitFor(() => expect(registeredPicker.current).not.toBeNull())

      const promise = openPicker()

      await waitFor(() =>
        expect(screen.getByText('No subdirectories in this folder')).toBeInTheDocument()
      )

      fireEvent.keyDown(window, { key: 'Escape' })

      const result = await promise
      expect(result).toEqual({
        success: false,
        error: 'No directory selected',
        code: 'CANCELLED'
      })
    })
  })

  describe('path helpers', () => {
    it('parentPath ascends a POSIX path', () => {
      expect(__testing.parentPath('/home/foo')).toBe('/home')
      expect(__testing.parentPath('/home')).toBe('/')
    })

    it('parentPath returns null at POSIX root', () => {
      expect(__testing.parentPath('/')).toBeNull()
    })

    it('parentPath ascends a Windows path', () => {
      expect(__testing.parentPath('C:\\Users\\foo')).toBe('C:/Users')
      expect(__testing.parentPath('C:/Users/foo')).toBe('C:/Users')
    })

    it('parentPath returns the drive root with a trailing separator', () => {
      expect(__testing.parentPath('C:/Users')).toBe('C:/')
      expect(__testing.parentPath('C:\\Users')).toBe('C:/')
    })

    it('parentPath returns null at a Windows drive root', () => {
      expect(__testing.parentPath('C:\\')).toBeNull()
      expect(__testing.parentPath('C:/')).toBeNull()
    })

    it('parentPath returns null for empty input', () => {
      expect(__testing.parentPath('')).toBeNull()
    })

    // Patch F: UNC paths preserve the double-leading-slash on rejoin, and
    // the UNC share root (`\\server\share`) returns null (Up disabled at the
    // share root). Without the fix, `\\server\share\foo` would normalize to
    // `//server/share/foo`, parent `//server/share`, rejoin via the non-drive
    // branch as `/server/share` (single slash) — Windows resolves it as a
    // relative POSIX path → wrong dir or READ_ERROR.
    it('parentPath preserves UNC double-slash and nulls at share root (Patch F)', () => {
      // Double-backslash UNC (Windows native).
      expect(__testing.parentPath('\\\\server\\share\\foo')).toBe('//server/share')
      expect(__testing.parentPath('\\\\server\\share\\foo\\bar')).toBe('//server/share/foo')
      // Already-normalized double-slash UNC.
      expect(__testing.parentPath('//server/share/foo')).toBe('//server/share')
      expect(__testing.parentPath('//server/share/foo/bar')).toBe('//server/share/foo')
      // UNC share root: `\\server\share` has no parent — Up disabled.
      expect(__testing.parentPath('\\\\server\\share')).toBeNull()
      expect(__testing.parentPath('//server/share')).toBeNull()
    })

    it('isUnc detects UNC paths after normalization', () => {
      expect(__testing.isUnc('\\\\server\\share\\foo')).toBe(true)
      expect(__testing.isUnc('//server/share/foo')).toBe(true)
      expect(__testing.isUnc('//server/share')).toBe(true)
      // Plain drive path is NOT UNC.
      expect(__testing.isUnc('C:\\Users')).toBe(false)
      expect(__testing.isUnc('C:/Users')).toBe(false)
      // POSIX is NOT UNC.
      expect(__testing.isUnc('/home/foo')).toBe(false)
      // Single leading slash is NOT UNC.
      expect(__testing.isUnc('/server/share')).toBe(false)
    })

    it('childPath joins with a separator', () => {
      expect(__testing.childPath('/root', 'sub')).toBe('/root/sub')
      expect(__testing.childPath('/root/', 'sub')).toBe('/root/sub')
      expect(__testing.childPath('C:/Users', 'foo')).toBe('C:/Users/foo')
    })

    it('childPath returns the name alone when parent is empty', () => {
      expect(__testing.childPath('', 'sub')).toBe('sub')
    })
  })
})
