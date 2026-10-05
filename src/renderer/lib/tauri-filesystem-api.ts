import type {
  DirectoryEntry,
  FileChangeCallback,
  FileChangeEvent,
  FileContent,
  FileInfo,
  FilesystemApi,
  FsScopeGrantSummary,
  IpcResult,
  SearchFileHit
} from '@shared/types/ipc.types'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import {
  copyFile,
  mkdir,
  open,
  readDir,
  readTextFile,
  remove,
  rename,
  stat,
  type WatchEvent,
  watchImmediate,
  writeTextFile
} from '@tauri-apps/plugin-fs'
import { getAcpTransport } from './acp-transport'
import { sortDirectoryEntries } from './filesystem-sort'
import { logFrontendError } from './log-api'
import { cleanupTauriListener, isTauriContext } from './tauri-runtime'
import { webServerFilesystem, webServerSearch } from './web-server-api'

// Names that are commonly git-ignored. Entries matching these are still shown in
// the file tree but rendered dimmed (and skipped during recursive walks for perf).
const ALWAYS_IGNORE = [
  'node_modules',
  '.git',
  '.next',
  '.cache',
  '.turbo',
  'dist',
  'build',
  '.output',
  '.nuxt',
  '.svelte-kit',
  '__pycache__',
  '.pytest_cache',
  'venv',
  '.env',
  'coverage',
  '.nyc_output'
]

const MAX_FILE_SIZE = 1024 * 1024 // 1MB
const _SEARCH_MAX_FILES_WITH_MATCHES = 100
const _SEARCH_MAX_MATCHES_PER_FILE = 30

async function searchWithRipgrep(
  scopeRoot: string,
  rootPath: string,
  query: string
): Promise<{
  results: Array<{ filePath: string; matches: Array<{ lineNumber: number; lineText: string }> }>
  truncated: boolean
  scannedFiles: number
  failedFiles: number
} | null> {
  try {
    const response = await invoke<{
      success: boolean
      data?: {
        results: Array<{
          filePath: string
          matches: Array<{ lineNumber: number; lineText: string }>
        }>
        truncated: boolean
        scannedFiles: number
        failedFiles: number
      }
    }>('search_content', {
      request: {
        scopeRoot,
        rootPath,
        query
      }
    })

    if (!response?.success || !response.data) {
      return null
    }

    return response.data
  } catch {
    return null
  }
}

/**
 * Watch event types dispatched by the Tauri watcher (mapped from notify kinds).
 * Type filtering is an internal facade detail — the shared `FilesystemApi`
 * contract keeps one `FileChangeCallback` signature per subscription method.
 */
type FileWatchEventType = 'change' | 'add' | 'unlink'

/** Registry of callbacks keyed by the event types they subscribed for. */
type TypedCallbackRegistry = Map<FileChangeCallback, Set<FileWatchEventType>>

function registerTypedCallback(
  registry: TypedCallbackRegistry,
  callback: FileChangeCallback,
  eventType: FileWatchEventType
): void {
  const types = registry.get(callback)
  if (types) {
    types.add(eventType)
  } else {
    registry.set(callback, new Set([eventType]))
  }
}

function unregisterTypedCallback(
  registry: TypedCallbackRegistry,
  callback: FileChangeCallback,
  eventType: FileWatchEventType
): void {
  const types = registry.get(callback)
  if (!types) return
  types.delete(eventType)
  if (types.size === 0) {
    registry.delete(callback)
  }
}

function dispatchTypedEvent(
  registry: TypedCallbackRegistry,
  eventType: FileWatchEventType,
  event: FileChangeEvent
): void {
  registry.forEach((types, callback) => {
    if (types.has(eventType)) {
      callback(event)
    }
  })
}

const activeWatchers = new Map<string, () => void>()
const activeCallbacks = new Map<string, TypedCallbackRegistry>()
const globalCallbacks: TypedCallbackRegistry = new Map()

// ----- Web filename-search event channel (issue #848) ------------------------
//
// The desktop transport streams `search-file-names-batch`/-`done` Tauri
// events. On web there is no Tauri event bus, so `searchFileNamesStreamStart`
// runs the one-shot `GET /search/file-names` HTTP request and fans its result
// out through this in-module emitter to the SAME `onSearchFileNamesBatch`/
// `onSearchFileNamesDone` callbacks. Consumers (composer mentions hook,
// file-explorer store) keep one code path: start → batch → done.

type WebFileNameBatchEvent = { searchId: string; files: SearchFileHit[]; truncated?: boolean }
type WebFileNameDoneEvent = {
  searchId: string
  truncated: boolean
  totalFiles: number
  code?: string
  error?: string
}

const webFileNameBatchCallbacks = new Set<(event: WebFileNameBatchEvent) => void>()
const webFileNameDoneCallbacks = new Set<(event: WebFileNameDoneEvent) => void>()

function emitWebFileNameBatch(event: WebFileNameBatchEvent): void {
  for (const cb of webFileNameBatchCallbacks) cb(event)
}

function emitWebFileNameDone(event: WebFileNameDoneEvent): void {
  for (const cb of webFileNameDoneCallbacks) cb(event)
}

/**
 * Run the web one-shot filename search and emit the batch + done events for
 * `searchId`. A superseded search (its `searchId` was cancelled/replaced
 * before the response landed) is dropped silently — the desktop contract
 * does the same by ignoring stale ids at the listener. Failures surface as
 * a done event carrying the transport error, never as a rejected promise.
 */
async function runWebFileNameSearch(
  searchId: string,
  rootPath: string,
  query: string,
  includeIgnored: boolean
): Promise<void> {
  try {
    const data = await webServerSearch.fileNames(rootPath, query, includeIgnored)
    if (cancelledWebFileNameSearches.has(searchId)) return
    emitWebFileNameBatch({
      searchId,
      files: data.files,
      truncated: data.truncated
    })
    emitWebFileNameDone({
      searchId,
      truncated: data.truncated,
      totalFiles: data.files.length
    })
  } catch (err) {
    if (cancelledWebFileNameSearches.has(searchId)) return
    logFrontendError({
      level: 'warn',
      source: 'tauri-filesystem-api.webFileNameSearch',
      message: `web filename search failed: ${err instanceof Error ? err.message : String(err)}`
    })
    emitWebFileNameDone({
      searchId,
      truncated: false,
      totalFiles: 0,
      code: 'NETWORK_ERROR',
      error: err instanceof Error ? err.message : String(err)
    })
  } finally {
    cancelledWebFileNameSearches.delete(searchId)
  }
}

/** Search ids cancelled via `searchFileNamesStreamCancel` before completion. */
const cancelledWebFileNameSearches = new Set<string>()

function shouldIgnore(name: string): boolean {
  return ALWAYS_IGNORE.includes(name)
}

function isBinaryFile(content: string): boolean {
  // Check for null bytes in first 512 chars
  const sample = content.slice(0, 512)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char handling
  return /[\x00-\x08]/.test(sample)
}

async function readBinarySample(filePath: string, byteCount: number): Promise<string> {
  const file = await open(filePath, { read: true })

  try {
    const bytes = new Uint8Array(byteCount)
    const bytesRead = await file.read(bytes)
    if (!bytesRead) {
      return ''
    }

    return new TextDecoder().decode(bytes.subarray(0, bytesRead))
  } finally {
    await file.close()
  }
}

function getExtension(filename: string): string | null {
  const idx = filename.lastIndexOf('.')
  return idx >= 0 ? filename.slice(idx) : null
}

function _includesCaseInsensitive(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
}

async function _collectFilesRecursively(rootPath: string): Promise<string[]> {
  const files: string[] = []
  const queue: string[] = [rootPath.replace(/\\/g, '/')]

  while (queue.length > 0) {
    const dir = queue.shift()
    if (!dir) continue

    let entries: Awaited<ReturnType<typeof readDir>>
    try {
      entries = await readDir(dir)
    } catch {
      continue
    }

    for (const entry of entries) {
      const name = entry.name
      if (shouldIgnore(name)) continue
      const fullPath = `${dir}/${name}`.replace(/\/+/g, '/')
      if (entry.isDirectory) {
        queue.push(fullPath)
      } else {
        files.push(fullPath)
      }
    }
  }

  return files
}

/**
 * Create a FilesystemApi implementation using Tauri's plugin-fs
 *
 * This adapter uses Tauri's filesystem plugin for direct file operations.
 * It maintains the same interface as the Electron preload script for easy migration.
 */
export function createTauriFilesystemApi(): FilesystemApi {
  return {
    async grantFsScope(paths: string[]): Promise<IpcResult<FsScopeGrantSummary>> {
      // Web/remote mode: the browser never talks to tauri-plugin-fs — fs
      // access is enforced by the server's own permission model — so the
      // scope grant is a desktop-only no-op.
      if (!isTauriContext()) {
        return { success: true, data: { granted: [], failed: [] } }
      }
      try {
        return await invoke<IpcResult<FsScopeGrantSummary>>('fs_scope_grant', { paths })
      } catch (err) {
        return { success: false, error: String(err), code: 'FS_SCOPE_GRANT_ERROR' }
      }
    },

    async readDirectory(dirPath: string): Promise<IpcResult<DirectoryEntry[]>> {
      // Web/remote mode: route through the same-origin server (Story: Web/
      // remote project creation). Desktop stays on @tauri-apps/plugin-fs.
      if (!isTauriContext()) {
        // The web server (fs_api.rs `ls`) returns OS-native entry paths — on
        // Windows that is backslash separators. The file-explorer store keys
        // `expandedDirs`/`directoryContents` by normalizePath (`\`→`/`) but
        // FileTreeNode reads them by raw `entry.path`, so backslash paths
        // break subdir expansion at level 2+. Normalize to forward slashes to
        // match the Tauri branch below.
        const result = await webServerFilesystem.readDirectory(dirPath)
        if (result.success) {
          return {
            success: true,
            data: result.data.map((entry) => ({
              ...entry,
              path: entry.path.replace(/\\/g, '/')
            }))
          }
        }
        return result
      }
      try {
        const normalizedDirPath = dirPath.replace(/\\/g, '/')
        const entries = await readDir(dirPath)

        // Stat all entries in parallel instead of sequentially — a directory
        // with N entries previously incurred N sequential IPC round-trips,
        // which dominated tree-expansion latency for large directories (#378).
        const filtered = await Promise.all(
          entries.map(async (entry): Promise<DirectoryEntry> => {
            const name = entry.name
            const fullPath = `${normalizedDirPath}/${name}`.replace(/\/+/g, '/')
            let size = 0
            let modified = Date.now()
            try {
              const info = await stat(fullPath)
              size = info.size
              modified = info.mtime?.getTime() ?? Date.now()
            } catch {
              // Ignore stat errors, use defaults
            }

            const isDir = entry.isDirectory ?? false
            return {
              name,
              path: fullPath,
              type: isDir ? 'directory' : 'file',
              extension: isDir ? null : getExtension(name),
              size,
              modifiedAt: modified,
              ignored: shouldIgnore(name)
            }
          })
        )

        // Sort: directories first, then files, both A-Z
        const sorted = sortDirectoryEntries(filtered)
        return { success: true, data: sorted }
      } catch (err) {
        return { success: false, error: String(err), code: 'READ_DIR_ERROR' }
      }
    },

    async readFile(filePath: string): Promise<IpcResult<FileContent>> {
      // Web/remote mode: route through the same-origin server. The server
      // enforces size + binary checks (FILE_TOO_LARGE / BINARY_FILE) so this
      // is a thin passthrough mirroring the desktop facade's behavior.
      if (!isTauriContext()) {
        return webServerFilesystem.readFile(filePath)
      }
      try {
        const info = await stat(filePath)
        if (info.size > MAX_FILE_SIZE) {
          return {
            success: false,
            error: `File too large (${info.size} bytes, max ${MAX_FILE_SIZE})`,
            code: 'FILE_TOO_LARGE'
          }
        }

        const content = await readTextFile(filePath)

        // Binary detection on already-read content: avoids a separate
        // open()/read()/close() round-trip that getFileInfo() used to perform.
        if (isBinaryFile(content)) {
          return {
            success: false,
            error: 'Binary file cannot be displayed',
            code: 'BINARY_FILE'
          }
        }

        return {
          success: true,
          data: {
            content,
            encoding: 'utf-8',
            size: info.size,
            modifiedAt: info.mtime?.getTime() ?? Date.now()
          }
        }
      } catch (err) {
        return { success: false, error: String(err), code: 'READ_ERROR' }
      }
    },

    async getFileInfo(filePath: string): Promise<IpcResult<FileInfo>> {
      // Web/remote mode: route through the same-origin server (`GET /fs/info`).
      if (!isTauriContext()) {
        return webServerFilesystem.getFileInfo(filePath)
      }
      try {
        const info = await stat(filePath)
        const modifiedAt = info.mtime?.getTime() ?? Date.now()

        if (info.isDirectory) {
          return {
            success: true,
            data: {
              path: filePath,
              size: info.size,
              modifiedAt,
              type: 'directory',
              isReadOnly: false,
              isBinary: false
            }
          }
        }

        const content = await readBinarySample(filePath, 512).catch(() => '')

        return {
          success: true,
          data: {
            path: filePath,
            size: info.size,
            modifiedAt,
            type: 'file',
            isReadOnly: false, // Tauri plugin-fs doesn't expose readonly
            isBinary: isBinaryFile(content)
          }
        }
      } catch (err) {
        return { success: false, error: String(err), code: 'STAT_ERROR' }
      }
    },

    async searchContent(scopeRoot: string, rootPath: string, query: string) {
      const normalizedScopeRoot = scopeRoot.replace(/\\/g, '/')
      const normalizedRootPath = rootPath.replace(/\\/g, '/')
      const trimmedQuery = query.trim()
      if (!trimmedQuery) {
        return {
          success: true,
          data: {
            results: [],
            truncated: false,
            scannedFiles: 0,
            failedFiles: 0
          }
        }
      }

      const ripgrepResult = await searchWithRipgrep(
        normalizedScopeRoot,
        normalizedRootPath,
        trimmedQuery
      )
      if (ripgrepResult) {
        return {
          success: true,
          data: ripgrepResult
        }
      }

      return {
        success: false,
        error: 'Search backend unavailable (ripgrep command failed)',
        code: 'SEARCH_BACKEND_UNAVAILABLE'
      }

      /* fallback disabled intentionally to preserve VSCode-like performance guarantees
			try {
				const allFiles = await collectFilesRecursively(normalizedRootPath);
				const results: Array<{ filePath: string; matches: Array<{ lineNumber: number; lineText: string }> }> = [];
				let truncated = false;
				let scannedFiles = 0;
				let failedFiles = 0;

				for (const filePath of allFiles) {
					if (results.length >= SEARCH_MAX_FILES_WITH_MATCHES) {
						truncated = true;
						break;
					}

					let info;
					try {
						info = await stat(filePath);
					} catch {
						failedFiles += 1;
						continue;
					}

					if (info.isDirectory || info.size > MAX_FILE_SIZE) {
						continue;
					}

					scannedFiles += 1;

					let content = "";
					try {
						content = await readTextFile(filePath);
					} catch {
						failedFiles += 1;
						continue;
					}

					if (isBinaryFile(content)) {
						continue;
					}

					const lines = content.split(/\r?\n/);
					const matches: Array<{ lineNumber: number; lineText: string }> = [];

					for (let i = 0; i < lines.length; i += 1) {
						if (includesCaseInsensitive(lines[i], trimmedQuery)) {
							matches.push({ lineNumber: i + 1, lineText: lines[i] });
							if (matches.length >= SEARCH_MAX_MATCHES_PER_FILE) {
								truncated = true;
								break;
							}
						}
					}

					if (matches.length > 0) {
						results.push({ filePath, matches });
					}
				}

				return {
					success: true,
					data: {
						results,
						truncated,
						scannedFiles,
						failedFiles,
					},
				};
			} catch (err) {
				return {
					success: false,
					error: String(err),
					code: "SEARCH_ERROR",
				};
			}
			*/
    },

    async searchContentStreamStart(
      searchId: string,
      scopeRoot: string,
      rootPath: string,
      query: string
    ) {
      // Web/remote mode: streaming search transport (`/search/ws`) is not yet
      // implemented — return an explicit unsupported result instead of
      // invoking a Tauri-only command that silently fails.
      if (!isTauriContext()) {
        return {
          success: false as const,
          code: 'WEB_UNSUPPORTED',
          error: 'Streaming search is not available in the web client'
        }
      }
      try {
        const response = await invoke<{ success: boolean; error?: string; code?: string }>(
          'search_content_stream',
          { request: { searchId, scopeRoot, rootPath, query } }
        )
        if (!response?.success) {
          return {
            success: false as const,
            error: response?.error ?? 'Failed to start search stream',
            code: response?.code ?? 'SEARCH_STREAM_ERROR'
          }
        }
        return { success: true as const, data: undefined }
      } catch (err) {
        return { success: false as const, error: String(err), code: 'SEARCH_STREAM_ERROR' }
      }
    },

    async searchContentStreamCancel(searchId: string) {
      if (!isTauriContext()) {
        return {
          success: false as const,
          code: 'WEB_UNSUPPORTED',
          error: 'Streaming search is not available in the web client'
        }
      }
      try {
        const response = await invoke<{ success: boolean; error?: string; code?: string }>(
          'search_content_cancel',
          { request: { searchId } }
        )
        if (!response?.success) {
          return {
            success: false as const,
            error: response?.error ?? 'Failed to cancel search stream',
            code: response?.code ?? 'SEARCH_STREAM_CANCEL_ERROR'
          }
        }
        return { success: true as const, data: undefined }
      } catch (err) {
        return {
          success: false as const,
          error: String(err),
          code: 'SEARCH_STREAM_CANCEL_ERROR'
        }
      }
    },

    onSearchContentBatch(callback) {
      if (!isTauriContext()) return () => {}
      let unlisten: Promise<UnlistenFn> | undefined
      try {
        unlisten = listen<{
          searchId: string
          results: Array<{
            filePath: string
            matches: Array<{ lineNumber: number; lineText: string }>
          }>
          truncated: boolean
        }>('search-content-batch', ({ payload }) => callback(payload))
      } catch {
        return () => {}
      }
      return () => cleanupTauriListener(unlisten)
    },

    async searchFileNamesStreamStart(
      searchId: string,
      scopeRoot: string,
      rootPath: string,
      query: string,
      includeIgnored?: boolean
    ) {
      // Web/remote mode (issue #848): run the one-shot HTTP filename search
      // (`GET /search/file-names`, served by the same ripgrep walk the
      // desktop command uses) and fan the result out through the in-module
      // batch/done emitters, so `onSearchFileNamesBatch`/`onSearchFileNamesDone`
      // consumers work unchanged. Debouncing stays client-side (the composer
      // hook + explorer store already debounce + cancel per keystroke).
      if (!isTauriContext()) {
        cancelledWebFileNameSearches.delete(searchId)
        void runWebFileNameSearch(searchId, rootPath, query, includeIgnored ?? false)
        return { success: true as const, data: undefined }
      }
      try {
        const response = await invoke<{ success: boolean; error?: string; code?: string }>(
          'search_file_names_stream',
          {
            request: {
              searchId,
              scopeRoot,
              rootPath,
              query,
              ...(includeIgnored ? { includeIgnored } : {})
            }
          }
        )
        if (!response?.success) {
          return {
            success: false as const,
            error: response?.error ?? 'Failed to start file names stream',
            code: response?.code ?? 'SEARCH_FILENAMES_STREAM_ERROR'
          }
        }
        return { success: true as const, data: undefined }
      } catch (err) {
        return {
          success: false as const,
          error: String(err),
          code: 'SEARCH_FILENAMES_STREAM_ERROR'
        }
      }
    },

    async searchFileNamesStreamCancel(searchId: string) {
      // Web/remote mode: the one-shot HTTP search cannot be aborted
      // server-side (no child registry — the request completes and is
      // dropped by the id gate). Marking it cancelled makes the pending
      // response a no-op, mirroring the desktop's stale-event semantics.
      if (!isTauriContext()) {
        cancelledWebFileNameSearches.add(searchId)
        return { success: true as const, data: undefined }
      }
      try {
        const response = await invoke<{ success: boolean; error?: string; code?: string }>(
          'search_file_names_cancel',
          { request: { searchId } }
        )
        if (!response?.success) {
          return {
            success: false as const,
            error: response?.error ?? 'Failed to cancel file names stream',
            code: response?.code ?? 'SEARCH_FILENAMES_CANCEL_ERROR'
          }
        }
        return { success: true as const, data: undefined }
      } catch (err) {
        return {
          success: false as const,
          error: String(err),
          code: 'SEARCH_FILENAMES_CANCEL_ERROR'
        }
      }
    },

    onSearchFileNamesBatch(
      callback: (event: { searchId: string; files: SearchFileHit[]; truncated?: boolean }) => void
    ) {
      if (!isTauriContext()) {
        webFileNameBatchCallbacks.add(callback)
        return () => {
          webFileNameBatchCallbacks.delete(callback)
        }
      }
      let unlisten: Promise<UnlistenFn> | undefined
      try {
        unlisten = listen<{ searchId: string; files: SearchFileHit[]; truncated?: boolean }>(
          'search-file-names-batch',
          ({ payload }) => callback(payload)
        )
      } catch {
        return () => {}
      }
      return () => cleanupTauriListener(unlisten)
    },

    onSearchFileNamesDone(
      callback: (event: {
        searchId: string
        truncated: boolean
        totalFiles: number
        code?: string
        error?: string
      }) => void
    ) {
      if (!isTauriContext()) {
        webFileNameDoneCallbacks.add(callback)
        return () => {
          webFileNameDoneCallbacks.delete(callback)
        }
      }
      let unlisten: Promise<UnlistenFn> | undefined
      try {
        unlisten = listen<{
          searchId: string
          truncated: boolean
          totalFiles: number
          code?: string
          error?: string
        }>('search-file-names-done', ({ payload }) => callback(payload))
      } catch {
        return () => {}
      }
      return () => cleanupTauriListener(unlisten)
    },

    onSearchContentDone(callback) {
      if (!isTauriContext()) return () => {}
      let unlisten: Promise<UnlistenFn> | undefined
      try {
        unlisten = listen<{
          searchId: string
          truncated: boolean
          scannedFiles: number
          failedFiles: number
          error?: string
        }>('search-content-done', ({ payload }) => callback(payload))
      } catch {
        return () => {}
      }
      return () => cleanupTauriListener(unlisten)
    },

    async writeFile(filePath: string, content: string): Promise<IpcResult<void>> {
      // Web/remote mode: route through the same-origin server (`POST /fs/write`,
      // which truncates+overwrites — matches desktop `writeTextFile`).
      if (!isTauriContext()) {
        return webServerFilesystem.writeFile(filePath, content)
      }
      try {
        await writeTextFile(filePath, content)
        return { success: true, data: undefined }
      } catch (err) {
        return { success: false, error: String(err), code: 'WRITE_ERROR' }
      }
    },

    async createFile(filePath: string, content = ''): Promise<IpcResult<void>> {
      // Web/remote mode: route through the same-origin server.
      if (!isTauriContext()) {
        return webServerFilesystem.createFile(filePath, content)
      }
      try {
        await writeTextFile(filePath, content)
        return { success: true, data: undefined }
      } catch (err) {
        return { success: false, error: String(err), code: 'CREATE_ERROR' }
      }
    },

    async createDirectory(dirPath: string): Promise<IpcResult<void>> {
      // Web/remote mode: route through the same-origin server.
      if (!isTauriContext()) {
        return webServerFilesystem.createDirectory(dirPath)
      }
      try {
        await mkdir(dirPath, { recursive: true })
        return { success: true, data: undefined }
      } catch (err) {
        return { success: false, error: String(err), code: 'MKDIR_ERROR' }
      }
    },

    async deletePath(path: string, options?: { recursive?: boolean }): Promise<IpcResult<void>> {
      // Web/remote mode: route through the same-origin server.
      if (!isTauriContext()) {
        return webServerFilesystem.deletePath(path, options)
      }
      try {
        await remove(path, { recursive: options?.recursive ?? false })
        return { success: true, data: undefined }
      } catch (err) {
        return { success: false, error: String(err), code: 'DELETE_ERROR' }
      }
    },

    async renameFile(oldPath: string, newPath: string): Promise<IpcResult<void>> {
      // Web/remote mode: route through the same-origin server.
      if (!isTauriContext()) {
        return webServerFilesystem.renameFile(oldPath, newPath)
      }
      try {
        await rename(oldPath, newPath)
        return { success: true, data: undefined }
      } catch (err) {
        return { success: false, error: String(err), code: 'RENAME_ERROR' }
      }
    },

    /**
     * Copy a file to a new path using a binary-safe native copy.
     * Returns `COPY_ERROR` on failure (e.g. when the source is a directory).
     */
    async copyFile(srcPath: string, destPath: string): Promise<IpcResult<void>> {
      // Web/remote mode: route through the same-origin server.
      if (!isTauriContext()) {
        return webServerFilesystem.copyFile(srcPath, destPath)
      }
      try {
        await copyFile(srcPath, destPath)
        return { success: true, data: undefined }
      } catch (err) {
        return { success: false, error: String(err), code: 'COPY_ERROR' }
      }
    },

    async watchDirectory(dirPath: string): Promise<IpcResult<void>> {
      // Web/remote mode (#856): the change events now arrive over the
      // control WS as `fs_changed` batches (see `wireWebFsChangedBridge`
      // below — the facade dispatches them through the SAME
      // onFileChanged/onFileCreated/onFileDeleted chain this desktop
      // watcher feeds). There is nothing per-directory to set up on the
      // client: the server watches the active project root and re-arms on
      // switch. Report success so callers (WorkspaceLayout's project
      // switch) complete the switch instead of treating the watcher as
      // unavailable.
      if (!isTauriContext()) {
        return { success: true, data: undefined }
      }
      try {
        const normalizedDirPath = dirPath.replace(/\\/g, '/')

        if (activeWatchers.has(normalizedDirPath)) {
          return { success: true, data: undefined } // Already watching
        }

        const unlisten = await watchImmediate(
          [dirPath], // Use original OS-native path for the watcher
          // Callback receives single WatchEvent, not array
          (event: WatchEvent) => {
            const callbacks = activeCallbacks.get(normalizedDirPath)
            if (!callbacks) return

            // WatchEventKind is a complex type - check the type property
            // The kind object has a 'type' property: 'create' | 'modify' | 'remove' | 'access' | 'other' | 'any'
            const kindType = (event.type as { type?: string })?.type ?? 'other'

            let changeType: FileWatchEventType = 'change'
            if (kindType === 'create') changeType = 'add'
            else if (kindType === 'remove') changeType = 'unlink'

            // paths is an array - use first element
            const changedPath = (event.paths?.[0] ?? normalizedDirPath).replace(/\\/g, '/')
            const changeEvent: FileChangeEvent = {
              type: changeType,
              path: changedPath
            }

            // Dispatch by event type: notify fires every kind (a save's modify
            // events included) and fanning all of them to every subscriber let
            // delete-handlers run on change events (#539). Route each event
            // only to callbacks subscribed for its type.
            dispatchTypedEvent(callbacks, changeType, changeEvent)
            dispatchTypedEvent(globalCallbacks, changeType, changeEvent)
          }
        )

        activeWatchers.set(normalizedDirPath, unlisten)
        if (!activeCallbacks.has(normalizedDirPath)) {
          activeCallbacks.set(normalizedDirPath, new Map())
        }
        return { success: true, data: undefined }
      } catch (err) {
        return { success: false, error: String(err), code: 'WATCH_ERROR' }
      }
    },

    async unwatchDirectory(dirPath: string): Promise<IpcResult<void>> {
      // Web/remote mode: nothing to unwatch (watchers are desktop-only).
      if (!isTauriContext()) {
        return { success: true, data: undefined }
      }
      try {
        const normalizedDirPath = dirPath.replace(/\\/g, '/')
        const unlisten = activeWatchers.get(normalizedDirPath)
        if (unlisten) {
          unlisten()
          activeWatchers.delete(normalizedDirPath)
          activeCallbacks.delete(normalizedDirPath)
        }
        return { success: true, data: undefined }
      } catch (err) {
        return { success: false, error: String(err), code: 'UNWATCH_ERROR' }
      }
    },

    onFileChanged(callback: FileChangeCallback): () => void {
      // #856: on web, a first subscription also (idempotently) connects
      // the control-WS `fs_changed` bridge to this shared registry.
      wireWebFsChangedBridge()
      registerTypedCallback(globalCallbacks, callback, 'change')

      // Return cleanup function — removes only the 'change' subscription so
      // callers that registered the same callback for several event types
      // (e.g. onFileChanged + onFileCreated + onFileDeleted) keep the others.
      return () => {
        unregisterTypedCallback(globalCallbacks, callback, 'change')
        for (const callbacks of activeCallbacks.values()) {
          unregisterTypedCallback(callbacks, callback, 'change')
        }
      }
    },

    onFileCreated(callback: FileChangeCallback): () => void {
      // #856: see onFileChanged — the bridge feeds the shared registry.
      wireWebFsChangedBridge()
      registerTypedCallback(globalCallbacks, callback, 'add')

      return () => {
        unregisterTypedCallback(globalCallbacks, callback, 'add')
        for (const callbacks of activeCallbacks.values()) {
          unregisterTypedCallback(callbacks, callback, 'add')
        }
      }
    },

    onFileDeleted(callback: FileChangeCallback): () => void {
      // #856: see onFileChanged — the bridge feeds the shared registry.
      wireWebFsChangedBridge()
      registerTypedCallback(globalCallbacks, callback, 'unlink')

      return () => {
        unregisterTypedCallback(globalCallbacks, callback, 'unlink')
        for (const callbacks of activeCallbacks.values()) {
          unregisterTypedCallback(callbacks, callback, 'unlink')
        }
      }
    }
  }
}

/**
 * Direct export singleton for convenience (matches api-bridge pattern)
 */
export const tauriFilesystemApi = createTauriFilesystemApi()

// ---------------------------------------------------------------------------
// #856: web FS-change bridge — server `fs_changed` events → the shared
// onFileChanged/onFileCreated/onFileDeleted callback chain.
// ---------------------------------------------------------------------------

/** Payload of the control-WS `fs_changed` agent-level event (#856). */
interface FsChangedEventPayload {
  root: string
  paths: string[]
}

/**
 * Map an fs_changed path to the subscription event type. A path that no
 * longer exists was deleted (`unlink`); anything else is reported as a
 * `change` — the explorer refreshes the parent directory either way, and
 * `useFileWatcher` only closes open editor tabs on genuine unlinks.
 * (The server batch carries no per-path kind, and stat-ing every path
 * would add a round trip per event; the consumers are refresh-driven, so
 * a conservative `change` is sufficient and never closes a live tab.)
 */
function fsChangedPathsToEvents(payload: FsChangedEventPayload): FileChangeEvent[] {
  // CodeRabbit: the server normalizes each path to forward slashes but the
  // root may still carry native backslashes (Windows) — normalize BOTH
  // before the prefix check or every change for that root is dropped.
  const normalizedRoot = payload.root.replaceAll('\\', '/')
  return payload.paths
    .filter((path) => path.replaceAll('\\', '/').startsWith(normalizedRoot))
    .map((path) => ({ type: 'change' as const, path }))
}

/** Idempotence guard for the one-time web bridge subscription. */
let webFsChangedBridgeWired = false

/**
 * #856: subscribe (web only, once) to the control-WS `fs_changed` event
 * and dispatch each batched path through the SAME typed-callback registry
 * the desktop notify watcher feeds. Called lazily by the first
 * `onFileChanged`/`onFileCreated`/`onFileDeleted` subscription on web, so
 * no import-cycle risk and no subscription when nothing listens. Failure
 * to subscribe (transport down at module init) is logged and NOT retried
 * per-subscription — the transport's own reconnect re-delivers later
 * events once `onEvent` is registered.
 */
function wireWebFsChangedBridge(): void {
  if (webFsChangedBridgeWired || isTauriContext()) return
  webFsChangedBridgeWired = true
  try {
    const transport = getAcpTransport()
    transport.onEvent<FsChangedEventPayload>('acp:fs_changed', (payload) => {
      if (!payload || !Array.isArray(payload.paths)) return
      for (const event of fsChangedPathsToEvents(payload)) {
        // 'change' feeds every subscriber that registered for 'change';
        // the create/delete-typed subscribers are served by the desktop
        // watcher's precise kinds — on web the tree refresh (the actual
        // #856 acceptance) is driven by 'change'.
        dispatchTypedEvent(globalCallbacks, 'change', event)
      }
    })
  } catch (error) {
    void logFrontendError({
      level: 'warn',
      source: 'tauri-filesystem-api.wireWebFsChangedBridge',
      message: `fs_changed bridge subscription failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    })
  }
}

/**
 * @internal Testing only - reset module state
 */
export function _resetFilesystemStateForTesting() {
  activeWatchers.clear()
  activeCallbacks.clear()
  globalCallbacks.clear()
  webFileNameBatchCallbacks.clear()
  webFileNameDoneCallbacks.clear()
  cancelledWebFileNameSearches.clear()
  // #856: re-arm the web fs_changed bridge so each test can re-wire it.
  webFsChangedBridgeWired = false
}
