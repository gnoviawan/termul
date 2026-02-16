import { create } from 'zustand'
import { useShallow } from 'zustand/shallow'

const EDITOR_TAB_LIMIT = 15

function getExtname(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() || filePath
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0) return ''
  return name.slice(dotIndex)
}

function detectLanguage(filePath: string): string {
  const ext = getExtname(filePath).slice(1).toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    css: 'css',
    scss: 'css',
    html: 'html',
    htm: 'html',
    md: 'markdown',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    svg: 'xml',
    sh: 'shell',
    bash: 'shell',
    py: 'python',
    rs: 'rust',
    go: 'go',
    toml: 'toml'
  }
  return map[ext] || ''
}

function getDefaultViewMode(filePath: string): 'code' | 'markdown' {
  const ext = getExtname(filePath).slice(1).toLowerCase()
  return ext === 'md' ? 'markdown' : 'code'
}

export interface EditorFileState {
  filePath: string
  content: string
  originalContent: string
  isDirty: boolean
  language: string
  lastModified: number
  viewMode: 'code' | 'markdown'
  cursorPosition: { line: number; col: number }
  scrollTop: number
}

export interface EditorState {
  openFiles: Map<string, EditorFileState>
  activeFilePath: string | null

  openFile: (path: string) => Promise<void>
  closeFile: (path: string) => void
  updateContent: (path: string, content: string) => void
  saveFile: (path: string) => Promise<boolean>
  saveAllDirty: () => Promise<void>
  setViewMode: (path: string, mode: 'code' | 'markdown') => void
  updateCursorPosition: (path: string, line: number, col: number) => void
  updateScrollTop: (path: string, scrollTop: number) => void
  reloadFile: (path: string) => Promise<void>
  setActiveFilePath: (path: string | null) => void
  hasDirtyFiles: () => boolean
  getOpenFilePaths: () => string[]
}

export const useEditorStore = create<EditorState>((set, get) => ({
  openFiles: new Map<string, EditorFileState>(),
  activeFilePath: null,

  openFile: async (path: string): Promise<void> => {
    const { openFiles } = get()

    // Already open, just activate
    if (openFiles.has(path)) {
      set({ activeFilePath: path })
      return
    }

    // Check file info first
    const infoResult = await window.api.filesystem.getFileInfo(path)
    if (!infoResult.success) {
      throw new Error(infoResult.error)
    }

    if (infoResult.data.isBinary) {
      throw new Error('Binary file cannot be displayed')
    }

    if (infoResult.data.size > 1024 * 1024) {
      throw new Error('File too large (>1MB)')
    }

    // Read file content
    const result = await window.api.filesystem.readFile(path)
    if (!result.success) {
      throw new Error(result.error)
    }

    const newFiles = new Map(get().openFiles)

    // Check tab limit - close oldest inactive non-dirty tab
    if (newFiles.size >= EDITOR_TAB_LIMIT) {
      const { activeFilePath } = get()
      let oldestPath: string | null = null
      let oldestTime = Infinity

      newFiles.forEach((file, filePath) => {
        if (filePath !== activeFilePath && !file.isDirty && file.lastModified < oldestTime) {
          oldestTime = file.lastModified
          oldestPath = filePath
        }
      })

      if (oldestPath) {
        newFiles.delete(oldestPath)
      }
    }

    const fileState: EditorFileState = {
      filePath: path,
      content: result.data.content,
      originalContent: result.data.content,
      isDirty: false,
      language: detectLanguage(path),
      lastModified: result.data.modifiedAt,
      viewMode: getDefaultViewMode(path),
      cursorPosition: { line: 1, col: 1 },
      scrollTop: 0
    }

    newFiles.set(path, fileState)
    set({ openFiles: newFiles, activeFilePath: path })
  },

  closeFile: (path: string): void => {
    const { openFiles, activeFilePath } = get()
    const newFiles = new Map(openFiles)
    newFiles.delete(path)

    let newActive = activeFilePath
    if (activeFilePath === path) {
      const paths = Array.from(newFiles.keys())
      newActive = paths.length > 0 ? paths[paths.length - 1] : null
    }

    set({ openFiles: newFiles, activeFilePath: newActive })
  },

  updateContent: (path: string, content: string): void => {
    const { openFiles } = get()
    const file = openFiles.get(path)
    if (!file) return

    const newFiles = new Map(openFiles)
    newFiles.set(path, {
      ...file,
      content,
      isDirty: content !== file.originalContent
    })
    set({ openFiles: newFiles })
  },

  saveFile: async (path: string): Promise<boolean> => {
    const { openFiles } = get()
    const file = openFiles.get(path)
    if (!file) return false

    const result = await window.api.filesystem.writeFile(path, file.content)
    if (!result.success) return false

    const newFiles = new Map(get().openFiles)
    const current = newFiles.get(path)
    if (current) {
      newFiles.set(path, {
        ...current,
        originalContent: current.content,
        isDirty: false,
        lastModified: Date.now()
      })
      set({ openFiles: newFiles })
    }

    return true
  },

  saveAllDirty: async (): Promise<void> => {
    const { openFiles } = get()
    const dirtyPaths: string[] = []
    openFiles.forEach((file, path) => {
      if (file.isDirty) dirtyPaths.push(path)
    })

    for (const path of dirtyPaths) {
      await get().saveFile(path)
    }
  },

  setViewMode: (path: string, mode: 'code' | 'markdown'): void => {
    const { openFiles } = get()
    const file = openFiles.get(path)
    if (!file) return

    const newFiles = new Map(openFiles)
    newFiles.set(path, { ...file, viewMode: mode })
    set({ openFiles: newFiles })
  },

  updateCursorPosition: (path: string, line: number, col: number): void => {
    const { openFiles } = get()
    const file = openFiles.get(path)
    if (!file) return

    const newFiles = new Map(openFiles)
    newFiles.set(path, { ...file, cursorPosition: { line, col } })
    set({ openFiles: newFiles })
  },

  updateScrollTop: (path: string, scrollTop: number): void => {
    const { openFiles } = get()
    const file = openFiles.get(path)
    if (!file) return

    const newFiles = new Map(openFiles)
    newFiles.set(path, { ...file, scrollTop })
    set({ openFiles: newFiles })
  },

  reloadFile: async (path: string): Promise<void> => {
    const { openFiles } = get()
    const file = openFiles.get(path)
    if (!file) return

    // Don't reload dirty files silently
    if (file.isDirty) return

    const result = await window.api.filesystem.readFile(path)
    if (!result.success) return

    const newFiles = new Map(get().openFiles)
    const current = newFiles.get(path)
    if (current) {
      newFiles.set(path, {
        ...current,
        content: result.data.content,
        originalContent: result.data.content,
        isDirty: false,
        lastModified: result.data.modifiedAt
      })
      set({ openFiles: newFiles })
    }
  },

  setActiveFilePath: (path: string | null): void => {
    set({ activeFilePath: path })
  },

  hasDirtyFiles: (): boolean => {
    const { openFiles } = get()
    let hasDirty = false
    openFiles.forEach((file) => {
      if (file.isDirty) hasDirty = true
    })
    return hasDirty
  },

  getOpenFilePaths: (): string[] => {
    return Array.from(get().openFiles.keys())
  }
}))

// Selector hooks
export function useOpenFiles(): Map<string, EditorFileState> {
  return useEditorStore((state) => state.openFiles)
}

export function useOpenFilePaths(): string[] {
  return useEditorStore(
    useShallow((state) => Array.from(state.openFiles.keys()))
  )
}

export function useOpenFile(filePath: string): EditorFileState | undefined {
  return useEditorStore((state) => state.openFiles.get(filePath))
}

export function useActiveFile(): EditorFileState | undefined {
  return useEditorStore((state) => {
    if (!state.activeFilePath) return undefined
    return state.openFiles.get(state.activeFilePath)
  })
}

export function useActiveFilePath(): string | null {
  return useEditorStore((state) => state.activeFilePath)
}

export function useEditorActions(): Pick<
  EditorState,
  | 'openFile'
  | 'closeFile'
  | 'updateContent'
  | 'saveFile'
  | 'saveAllDirty'
  | 'setViewMode'
  | 'updateCursorPosition'
  | 'updateScrollTop'
  | 'reloadFile'
  | 'setActiveFilePath'
> {
  return useEditorStore(
    useShallow((state) => ({
      openFile: state.openFile,
      closeFile: state.closeFile,
      updateContent: state.updateContent,
      saveFile: state.saveFile,
      saveAllDirty: state.saveAllDirty,
      setViewMode: state.setViewMode,
      updateCursorPosition: state.updateCursorPosition,
      updateScrollTop: state.updateScrollTop,
      reloadFile: state.reloadFile,
      setActiveFilePath: state.setActiveFilePath
    }))
  )
}

export function useDirtyFiles(): string[] {
  return useEditorStore(
    useShallow((state) => {
      const dirty: string[] = []
      state.openFiles.forEach((file, path) => {
        if (file.isDirty) dirty.push(path)
      })
      return dirty
    })
  )
}

export { detectLanguage, getDefaultViewMode }
