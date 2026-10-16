import type {
  DirectoryEntry,
  FileChangeCallback,
  FileChangeEvent,
  FileContent,
  FileInfo,
  FilesystemApi,
  FsScopeGrantSummary,
  FsWriteExpected,
  IpcResult,
  SearchFileHit
} from '@shared/types/ipc.types'
import type {
  FsWatchChangeDelta,
  FsWatchDelta,
  FsWatchState
} from '@shared/types/web-protocol.types'
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
import { useProjectStore } from '@/stores/project-store'
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

/**
 * A notify access event (open, read, close): not a change. A real write also
 * fires a `modify` event, so dropping close-after-write loses nothing. The
 * negation of the host watcher's `is_change_event`
 * (`src-tauri/src/web/fs_watcher/mod.rs`).
 */
function isAccessEvent(event: WatchEvent): boolean {
  const kind = event.type
  return typeof kind === 'object' && kind !== null && 'access' in kind
}

const activeWatchers = new Map<string, () => void>()

/**
 * Web/remote watch bookkeeping: normalized watched directory → the registered
 * project whose host watch serves it, and a refcount per project so the host
 * `fs` watch is requested once per project, not once per directory.
 */
const webWatchedDirs = new Map<string, string>()
const webProjectWatchRefs = new Map<string, number>()

function normalizeWatchPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

/**
 * The registered, non-archived project whose root contains `dirPath` (the
 * longest matching root wins), or `null` when none does.
 */
function resolveWatchProjectId(dirPath: string): string | null {
  const target = normalizeWatchPath(dirPath)
  let bestId: string | null = null
  let bestLength = -1
  for (const project of useProjectStore.getState().projects) {
    if (!project.path || project.isArchived) continue
    const root = normalizeWatchPath(project.path)
    const prefix = root.endsWith('/') ? root : `${root}/`
    const contains = target === root || target.startsWith(prefix)
    if (contains && root.length > bestLength) {
      bestId = project.id
      bestLength = root.length
    }
  }
  return bestId
}
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

    async writeFile(
      filePath: string,
      content: string,
      options?: { expected?: FsWriteExpected }
    ): Promise<IpcResult<void>> {
      // Web/remote mode: route through the same-origin server (`POST /fs/write`,
      // which truncates+overwrites — matches desktop `writeTextFile`).
      // `options.expected` is a web-host precondition; the desktop writes
      // through `plugin-fs` (a process boundary with no lost-reply window), so
      // it carries none.
      if (!isTauriContext()) {
        return webServerFilesystem.writeFile(filePath, content, options)
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
      // Web/remote mode (#856): the change events arrive over the control WS
      // as `fs` watch deltas (see `startProjectFsWatch` below — the facade
      // dispatches them through the SAME onFileChanged/onFileCreated/
      // onFileDeleted chain this desktop watcher feeds). There is nothing
      // per-directory to set up on the client beyond watching the project that
      // contains the directory (refcounted per project). A directory inside no
      // registered project has no host watch (the explorer simply gets no live
      // refresh) and still reports success.
      if (!isTauriContext()) {
        return watchWebDirectory(dirPath)
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
            // Reading a file (our own readTextFile included) fires access
            // events; reporting them as changes makes an open editor tab
            // reload, read, and reload again forever.
            if (isAccessEvent(event)) return

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
      // Web/remote mode: release the project's host watch when no watched
      // directory needs it any more.
      if (!isTauriContext()) {
        return unwatchWebDirectory(dirPath)
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
      registerTypedCallback(globalCallbacks, callback, 'add')

      return () => {
        unregisterTypedCallback(globalCallbacks, callback, 'add')
        for (const callbacks of activeCallbacks.values()) {
          unregisterTypedCallback(callbacks, callback, 'add')
        }
      }
    },

    onFileDeleted(callback: FileChangeCallback): () => void {
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
// #856: web FS-change watch — the host's `fs` watch deltas → the shared
// onFileChanged/onFileCreated/onFileDeleted callback chain.
// ---------------------------------------------------------------------------

/** Releases of the `fs` watch subscription, per project. */
const webFsSubscriptions = new Map<string, () => void>()
/** Projects whose `fs` watch already delivered a state: a later state is a resubscribe. */
const webFsStateSeen = new Set<string>()

function logWebWatchFailure(source: string, projectId: string, err: unknown): void {
  void logFrontendError({
    level: 'warn',
    source: `tauri-filesystem-api.${source}`,
    message: `Host watch for project ${projectId} failed: ${
      err instanceof Error ? err.message : String(err)
    }`
  })
}

/**
 * Web live refresh is best-effort: a host watch that cannot be set up (project
 * gone, socket down) is logged and the call still succeeds, so the explorer
 * root loads without a live-refresh subscription. The directory and its
 * refcount are claimed synchronously BEFORE the watch is requested, so a delta
 * that races the state frame is not dropped; the watch client asks the host
 * (and asks again after a reconnect), and a refusal re-arms with backoff.
 */
async function watchWebDirectory(dirPath: string): Promise<IpcResult<void>> {
  const normalized = normalizeWatchPath(dirPath)
  if (webWatchedDirs.has(normalized)) return { success: true, data: undefined }
  const projectId = resolveWatchProjectId(dirPath)
  if (!projectId) return { success: true, data: undefined }
  const watchedBefore = webProjectWatchRefs.has(projectId)
  claimWebWatch(normalized, projectId)
  // Directories of this project whose host watch ended and are still wanted
  // rejoin the active bookkeeping NOW, so unwatching this directory cannot
  // release the project while they remain mounted.
  const adopted = [...(webLostWatchDirs.get(projectId) ?? [])].filter(
    (dir) => !webWatchedDirs.has(dir)
  )
  webLostWatchDirs.delete(projectId)
  for (const dir of adopted) claimWebWatch(dir, projectId)
  if (!watchedBefore) startProjectFsWatch(projectId)
  return { success: true, data: undefined }
}

function claimWebWatch(normalizedDir: string, projectId: string): void {
  webWatchedDirs.set(normalizedDir, projectId)
  webProjectWatchRefs.set(projectId, (webProjectWatchRefs.get(projectId) ?? 0) + 1)
}

async function unwatchWebDirectory(dirPath: string): Promise<IpcResult<void>> {
  const normalized = normalizeWatchPath(dirPath)
  for (const lost of webLostWatchDirs.values()) lost.delete(normalized)
  const projectId = webWatchedDirs.get(normalized)
  if (!projectId) return { success: true, data: undefined }
  webWatchedDirs.delete(normalized)
  const refs = (webProjectWatchRefs.get(projectId) ?? 1) - 1
  if (refs > 0) {
    webProjectWatchRefs.set(projectId, refs)
    return { success: true, data: undefined }
  }
  webProjectWatchRefs.delete(projectId)
  stopProjectFsWatch(projectId)
  return { success: true, data: undefined }
}

/** Delays before each attempt to re-arm a watch the host ended (e.g. a root that vanished briefly). */
const REWATCH_DELAYS_MS = [2_000, 10_000, 30_000]
/** Directories whose host watch ended and are still wanted by the explorer, per project. */
const webLostWatchDirs = new Map<string, Set<string>>()
/** Pending re-arm timer per project. */
const webRewatchTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Re-arm attempts made since the project's watch last delivered a state. */
const webRewatchAttempts = new Map<string, number>()

/**
 * Subscribe to the host's `fs` watch of a project: the first state frame means
 * the watch is live; a later one means the stream was interrupted (reconnect,
 * lost delta, host restart), so every watched directory refreshes; each delta
 * feeds the shared callback chain; a final `ended` delta or a refusal forgets
 * the watch and re-arms the still-wanted directories with backoff.
 */
function startProjectFsWatch(projectId: string): void {
  const watches = getAcpTransport().watches
  if (!watches) return
  webFsStateSeen.delete(projectId)
  const release = watches.subscribe<FsWatchState, FsWatchDelta>(
    'fs',
    {
      onState: () => {
        webRewatchAttempts.delete(projectId)
        if (webFsStateSeen.has(projectId)) refreshWatchedDirs(projectId)
        else webFsStateSeen.add(projectId)
      },
      onDelta: (delta) => {
        // Only projects this client still wants (a late delta after unwatch).
        if (!webProjectWatchRefs.has(projectId) || !delta) return
        if ('ended' in delta) {
          rearmEndedWatch(projectId)
          return
        }
        if (!Array.isArray(delta.paths)) return
        for (const event of fsChangedPathsToEvents(delta)) {
          // 'change' feeds every subscriber that registered for 'change'; the
          // create/delete-typed subscribers are served by the desktop
          // watcher's precise kinds — on web the tree refresh (the actual #856
          // acceptance) is driven by 'change'.
          dispatchTypedEvent(globalCallbacks, 'change', event)
        }
      },
      onRefused: (error) => {
        logWebWatchFailure('startProjectFsWatch', projectId, error)
        rearmEndedWatch(projectId)
      }
    },
    projectId
  )
  webFsSubscriptions.set(projectId, release)
}

function stopProjectFsWatch(projectId: string): void {
  webFsStateSeen.delete(projectId)
  const release = webFsSubscriptions.get(projectId)
  webFsSubscriptions.delete(projectId)
  release?.()
}

/**
 * A new `fs` state after the first: changes may have been missed. Report one
 * change inside each watched directory, so the explorer refreshes it.
 */
function refreshWatchedDirs(projectId: string): void {
  for (const [dir, id] of webWatchedDirs) {
    if (id !== projectId) continue
    const path = dir.endsWith('/') ? `${dir}.` : `${dir}/.`
    dispatchTypedEvent(globalCallbacks, 'change', { type: 'change', path })
  }
}

/**
 * The host ended a project's watch or refused it: forget it, remember which
 * directories were watched, and retry a few times with backoff so live refresh
 * comes back when the project becomes watchable again. A directory unwatched
 * meanwhile is not re-armed.
 */
function rearmEndedWatch(projectId: string): void {
  const dirs = new Set<string>()
  for (const [dir, id] of webWatchedDirs) {
    if (id === projectId) dirs.add(dir)
  }
  forgetWebProjectWatch(projectId)
  if (dirs.size === 0) return
  webLostWatchDirs.set(projectId, dirs)
  scheduleRewatch(projectId)
}

function scheduleRewatch(projectId: string): void {
  const attempt = webRewatchAttempts.get(projectId) ?? 0
  const delay = REWATCH_DELAYS_MS[attempt]
  const pending = webRewatchTimers.get(projectId)
  if (pending) clearTimeout(pending)
  if (delay === undefined) {
    webRewatchTimers.delete(projectId)
    webLostWatchDirs.delete(projectId)
    webRewatchAttempts.delete(projectId)
    return
  }
  webRewatchAttempts.set(projectId, attempt + 1)
  const timer = setTimeout(() => {
    webRewatchTimers.delete(projectId)
    const first = webLostWatchDirs.get(projectId)?.values().next().value
    // Re-watched by a caller meanwhile (which adopted the lost directories),
    // or nothing is wanted any more.
    if (first === undefined) {
      webLostWatchDirs.delete(projectId)
      webRewatchAttempts.delete(projectId)
      return
    }
    // Claims every lost directory of the project together.
    void watchWebDirectory(first)
  }, delay)
  webRewatchTimers.set(projectId, timer)
}

/** Drop all client bookkeeping for a project whose host watch ended. */
function forgetWebProjectWatch(projectId: string): void {
  webProjectWatchRefs.delete(projectId)
  for (const [dir, id] of webWatchedDirs) {
    if (id === projectId) webWatchedDirs.delete(dir)
  }
  stopProjectFsWatch(projectId)
}

/**
 * Map one `fs` delta to subscription events. A path that no longer exists was
 * deleted (`unlink`); anything else is reported as a `change` — the explorer
 * refreshes the parent directory either way, and `useFileWatcher` only closes
 * open editor tabs on genuine unlinks. (The batch carries no per-path kind, and
 * stat-ing every path would add a round trip per event; the consumers are
 * refresh-driven, so a conservative `change` is sufficient and never closes a
 * live tab.)
 */
function fsChangedPathsToEvents(delta: FsWatchChangeDelta): FileChangeEvent[] {
  // CodeRabbit: the server normalizes each path to forward slashes but the
  // root may still carry native backslashes (Windows) — normalize BOTH
  // before the prefix check or every change for that root is dropped.
  const normalizedRoot = delta.root.replaceAll('\\', '/')
  return delta.paths
    .filter((path) => path.replaceAll('\\', '/').startsWith(normalizedRoot))
    .map((path) => ({ type: 'change' as const, path }))
}

/**
 * @internal Testing only - reset module state
 */
export function _resetFilesystemStateForTesting() {
  activeWatchers.clear()
  webWatchedDirs.clear()
  webProjectWatchRefs.clear()
  for (const release of webFsSubscriptions.values()) release()
  webFsSubscriptions.clear()
  webFsStateSeen.clear()
  for (const timer of webRewatchTimers.values()) clearTimeout(timer)
  webRewatchTimers.clear()
  webRewatchAttempts.clear()
  webLostWatchDirs.clear()
  activeCallbacks.clear()
  globalCallbacks.clear()
  webFileNameBatchCallbacks.clear()
  webFileNameDoneCallbacks.clear()
  cancelledWebFileNameSearches.clear()
}
