import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useFileExplorerStore } from './file-explorer-store'
import type { DirectoryEntry } from '@shared/types/filesystem.types'

const mockEntries: DirectoryEntry[] = [
  { name: 'src', path: '/project/src', type: 'directory', extension: null, size: 0, modifiedAt: 1000 },
  { name: 'index.ts', path: '/project/index.ts', type: 'file', extension: '.ts', size: 100, modifiedAt: 1000 }
]

const mockApi = {
  filesystem: {
    readDirectory: vi.fn().mockResolvedValue({ success: true, data: mockEntries }),
    watchDirectory: vi.fn().mockResolvedValue({ success: true }),
    unwatchDirectory: vi.fn().mockResolvedValue({ success: true })
  }
}

beforeEach(() => {
  vi.stubGlobal('api', mockApi)
  vi.clearAllMocks()

  useFileExplorerStore.setState({
    rootPath: null,
    expandedDirs: new Set<string>(),
    directoryContents: new Map<string, DirectoryEntry[]>(),
    selectedPath: null,
    isVisible: true,
    loadingDirs: new Set<string>(),
    rootLoadError: null
  })
})

describe('file-explorer-store', () => {
  describe('setRootPath', () => {
    it('should set root path and reset state', () => {
      const store = useFileExplorerStore.getState()
      store.setRootPath('/project')

      const state = useFileExplorerStore.getState()
      expect(state.rootPath).toBe('/project')
      expect(state.expandedDirs.size).toBe(0)
      expect(state.directoryContents.size).toBe(0)
      expect(state.selectedPath).toBeNull()
      expect(state.rootLoadError).toBeNull()
    })

    it('should normalize backslashes in rootPath', () => {
      const store = useFileExplorerStore.getState()
      store.setRootPath('C:\\Users\\test\\project')

      expect(useFileExplorerStore.getState().rootPath).toBe('C:/Users/test/project')
    })

    it('should set rootPath to null', () => {
      const store = useFileExplorerStore.getState()
      store.setRootPath('/something')
      store.setRootPath(null)

      expect(useFileExplorerStore.getState().rootPath).toBeNull()
    })

    it('should unwatch previously expanded directories', () => {
      useFileExplorerStore.setState({
        expandedDirs: new Set(['/project', '/project/src'])
      })

      useFileExplorerStore.getState().setRootPath('/other')

      expect(mockApi.filesystem.unwatchDirectory).toHaveBeenCalledWith('/project')
      expect(mockApi.filesystem.unwatchDirectory).toHaveBeenCalledWith('/project/src')
    })
  })

  describe('toggleDirectory - expand', () => {
    it('should expand a directory and store its contents', async () => {
      await useFileExplorerStore.getState().toggleDirectory('/project')

      const state = useFileExplorerStore.getState()
      expect(state.expandedDirs.has('/project')).toBe(true)
      expect(state.directoryContents.get('/project')).toEqual(mockEntries)
    })

    it('should call readDirectory and watchDirectory on expand', async () => {
      await useFileExplorerStore.getState().toggleDirectory('/project')

      expect(mockApi.filesystem.readDirectory).toHaveBeenCalledWith('/project')
      expect(mockApi.filesystem.watchDirectory).toHaveBeenCalledWith('/project')
    })

    it('should normalize backslash paths on expand', async () => {
      await useFileExplorerStore.getState().toggleDirectory('C:\\Users\\project')

      expect(mockApi.filesystem.readDirectory).toHaveBeenCalledWith('C:/Users/project')
      expect(useFileExplorerStore.getState().expandedDirs.has('C:/Users/project')).toBe(true)
    })

    it('should clear loadingDirs after expand completes', async () => {
      await useFileExplorerStore.getState().toggleDirectory('/project')

      expect(useFileExplorerStore.getState().loadingDirs.size).toBe(0)
    })

    it('should clear loadingDirs even when readDirectory fails', async () => {
      mockApi.filesystem.readDirectory.mockRejectedValueOnce(new Error('fail'))

      try {
        await useFileExplorerStore.getState().toggleDirectory('/project')
      } catch {
        // Expected to throw
      }

      expect(useFileExplorerStore.getState().loadingDirs.size).toBe(0)
    })

    it('should not expand if already loading', async () => {
      useFileExplorerStore.setState({
        loadingDirs: new Set(['/project'])
      })

      await useFileExplorerStore.getState().toggleDirectory('/project')

      expect(mockApi.filesystem.readDirectory).not.toHaveBeenCalled()
    })

    it('should not watch when readDirectory returns success: false', async () => {
      mockApi.filesystem.readDirectory.mockResolvedValueOnce({
        success: false,
        error: 'denied',
        code: 'PATH_INVALID'
      })

      await useFileExplorerStore.getState().toggleDirectory('/project')

      expect(mockApi.filesystem.watchDirectory).not.toHaveBeenCalled()
      expect(useFileExplorerStore.getState().expandedDirs.size).toBe(0)
    })

    it('should set rootLoadError for root failure when readDirectory returns success: false', async () => {
      useFileExplorerStore.getState().setRootPath('/project')
      mockApi.filesystem.readDirectory.mockResolvedValueOnce({
        success: false,
        error: 'denied',
        code: 'PATH_INVALID'
      })

      await useFileExplorerStore.getState().toggleDirectory('/project')

      expect(useFileExplorerStore.getState().rootLoadError).toEqual({
        message: 'denied',
        code: 'PATH_INVALID'
      })
    })

    it('should set rootLoadError for root failure when readDirectory throws', async () => {
      useFileExplorerStore.getState().setRootPath('/project')
      mockApi.filesystem.readDirectory.mockRejectedValueOnce(new Error('boom'))

      await useFileExplorerStore.getState().toggleDirectory('/project')

      expect(useFileExplorerStore.getState().rootLoadError).toEqual({
        message: 'boom',
        code: 'UNKNOWN_ERROR'
      })
    })

    it('should clear rootLoadError after successful root reload', async () => {
      useFileExplorerStore.setState({
        rootPath: '/project',
        rootLoadError: { message: 'failed', code: 'UNKNOWN_ERROR' }
      })

      await useFileExplorerStore.getState().toggleDirectory('/project')

      expect(useFileExplorerStore.getState().rootLoadError).toBeNull()
      expect(useFileExplorerStore.getState().directoryContents.get('/project')).toEqual(mockEntries)
    })
  })

  describe('toggleDirectory - collapse', () => {
    beforeEach(async () => {
      // Expand root and a child so we have nested state
      await useFileExplorerStore.getState().toggleDirectory('/project')
      vi.clearAllMocks()

      // Manually add a child expanded dir
      const state = useFileExplorerStore.getState()
      const newExpanded = new Set(state.expandedDirs)
      newExpanded.add('/project/src')
      const newContents = new Map(state.directoryContents)
      newContents.set('/project/src', [])
      useFileExplorerStore.setState({
        expandedDirs: newExpanded,
        directoryContents: newContents
      })
    })

    it('should collapse a directory and remove its contents', async () => {
      await useFileExplorerStore.getState().toggleDirectory('/project')

      const state = useFileExplorerStore.getState()
      expect(state.expandedDirs.has('/project')).toBe(false)
      expect(state.directoryContents.has('/project')).toBe(false)
    })

    it('should also collapse child directories', async () => {
      await useFileExplorerStore.getState().toggleDirectory('/project')

      const state = useFileExplorerStore.getState()
      expect(state.expandedDirs.has('/project/src')).toBe(false)
      expect(state.directoryContents.has('/project/src')).toBe(false)
    })

    it('should unwatch collapsed directory and its children', async () => {
      await useFileExplorerStore.getState().toggleDirectory('/project')

      expect(mockApi.filesystem.unwatchDirectory).toHaveBeenCalledWith('/project')
      expect(mockApi.filesystem.unwatchDirectory).toHaveBeenCalledWith('/project/src')
    })

    it('should match child directories with normalized paths on Windows', async () => {
      // Set up state with Windows-style paths (already normalized by store)
      useFileExplorerStore.setState({
        expandedDirs: new Set(['C:/Users/project', 'C:/Users/project/src']),
        directoryContents: new Map([
          ['C:/Users/project', mockEntries],
          ['C:/Users/project/src', []]
        ])
      })

      // Collapse using backslash path — should normalize and match children
      await useFileExplorerStore.getState().toggleDirectory('C:\\Users\\project')

      const state = useFileExplorerStore.getState()
      expect(state.expandedDirs.has('C:/Users/project')).toBe(false)
      expect(state.expandedDirs.has('C:/Users/project/src')).toBe(false)
    })
  })

  describe('refreshDirectory', () => {
    it('should update contents for a directory', async () => {
      const newEntries: DirectoryEntry[] = [
        { name: 'new.ts', path: '/project/new.ts', type: 'file', extension: '.ts', size: 50, modifiedAt: 2000 }
      ]
      mockApi.filesystem.readDirectory.mockResolvedValueOnce({ success: true, data: newEntries })

      useFileExplorerStore.setState({
        directoryContents: new Map([
          ['/project', mockEntries]
        ])
      })

      await useFileExplorerStore.getState().refreshDirectory('/project')

      expect(useFileExplorerStore.getState().directoryContents.get('/project')).toEqual(newEntries)
    })

    it('should normalize path before refresh', async () => {
      await useFileExplorerStore.getState().refreshDirectory('C:\\Users\\project')

      expect(mockApi.filesystem.readDirectory).toHaveBeenCalledWith('C:/Users/project')
    })

    it('should not throw when refresh fails', async () => {
      mockApi.filesystem.readDirectory.mockRejectedValueOnce(new Error('fail'))

      await expect(
        useFileExplorerStore.getState().refreshDirectory('/project')
      ).resolves.not.toThrow()
    })
  })

  describe('restoreExpandedDirs', () => {
    it('should restore only directories within root and skip missing paths', async () => {
      useFileExplorerStore.getState().setRootPath('/project')

      mockApi.filesystem.readDirectory.mockImplementation(async (path: string) => {
        if (path === '/project/src') {
          return { success: true, data: [] }
        }

        if (path === '/project/missing') {
          throw new Error('missing')
        }

        return { success: true, data: mockEntries }
      })

      await useFileExplorerStore.getState().restoreExpandedDirs([
        '/project',
        '/project/src',
        '/project/missing',
        '/other/src'
      ])

      const state = useFileExplorerStore.getState()
      expect(state.expandedDirs.has('/project/src')).toBe(true)
      expect(state.expandedDirs.has('/other/src')).toBe(false)
      expect(mockApi.filesystem.readDirectory).toHaveBeenCalledWith('/project/src')
      expect(mockApi.filesystem.readDirectory).toHaveBeenCalledWith('/project/missing')
    })
  })

  describe('collapseAll', () => {
    it('should collapse everything except root', async () => {
      // Set up expanded tree
      useFileExplorerStore.setState({
        rootPath: '/project',
        expandedDirs: new Set(['/project', '/project/src', '/project/src/lib']),
        directoryContents: new Map([
          ['/project', mockEntries],
          ['/project/src', []],
          ['/project/src/lib', []]
        ])
      })

      useFileExplorerStore.getState().collapseAll()

      const state = useFileExplorerStore.getState()
      expect(state.expandedDirs.size).toBe(1)
      expect(state.expandedDirs.has('/project')).toBe(true)
      expect(state.directoryContents.size).toBe(1)
      expect(state.directoryContents.has('/project')).toBe(true)
    })

    it('should unwatch non-root directories', () => {
      useFileExplorerStore.setState({
        rootPath: '/project',
        expandedDirs: new Set(['/project', '/project/src'])
      })

      useFileExplorerStore.getState().collapseAll()

      expect(mockApi.filesystem.unwatchDirectory).toHaveBeenCalledWith('/project/src')
      expect(mockApi.filesystem.unwatchDirectory).not.toHaveBeenCalledWith('/project')
    })
  })

  describe('selectPath', () => {
    it('should set selected path', () => {
      useFileExplorerStore.getState().selectPath('/project/file.ts')
      expect(useFileExplorerStore.getState().selectedPath).toBe('/project/file.ts')
    })

    it('should clear selected path with null', () => {
      useFileExplorerStore.getState().selectPath('/project/file.ts')
      useFileExplorerStore.getState().selectPath(null)
      expect(useFileExplorerStore.getState().selectedPath).toBeNull()
    })
  })

  describe('toggleVisibility', () => {
    it('should toggle isVisible', () => {
      expect(useFileExplorerStore.getState().isVisible).toBe(true)
      useFileExplorerStore.getState().toggleVisibility()
      expect(useFileExplorerStore.getState().isVisible).toBe(false)
      useFileExplorerStore.getState().toggleVisibility()
      expect(useFileExplorerStore.getState().isVisible).toBe(true)
    })
  })

  describe('setDirectoryContents / removeDirectoryContents', () => {
    it('should set and remove directory contents', () => {
      useFileExplorerStore.getState().setDirectoryContents('/dir', mockEntries)
      expect(useFileExplorerStore.getState().directoryContents.get('/dir')).toEqual(mockEntries)

      useFileExplorerStore.getState().removeDirectoryContents('/dir')
      expect(useFileExplorerStore.getState().directoryContents.has('/dir')).toBe(false)
    })
  })
})
