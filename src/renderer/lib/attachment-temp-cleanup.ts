import { remove } from '@tauri-apps/plugin-fs'

/**
 * Best-effort deletion of a temp file created by the composer (e.g. a pasted
 * screenshot written via `writeImageBytesToTempLink`). Never throws — temp
 * files may already be gone, live in a sandboxed dir the OS won't unlink, or
 * the fs plugin may be unavailable (tests).
 */
export async function deleteTempFile(path: string): Promise<void> {
  try {
    await remove(path)
  } catch {
    /* best-effort */
  }
}

// App-owned temp paths staged for a session's sent `resource_link` blocks. The
// agent reads these by path during the turn, so they cannot be deleted on send;
// they are cleaned up when the session closes (or is deleted) instead.
const sessionTempFiles = new Map<string, Set<string>>()

/**
 * Record app-owned temp paths that were sent with a session's prompt so they
 * can be deleted once the session is no longer active. Safe to call multiple
 * times for the same session (paths are merged).
 */
export function registerSessionTempFiles(sessionId: string, paths: readonly string[]): void {
  if (paths.length === 0) return
  const set = sessionTempFiles.get(sessionId) ?? new Set<string>()
  for (const p of paths) set.add(p)
  sessionTempFiles.set(sessionId, set)
}

/**
 * Delete every app-owned temp file registered for a session and clear the
 * registry entry. Called when a session is closed/deleted so sent temp files
 * do not linger in the OS temp dir forever.
 */
export async function deleteSessionTempFiles(sessionId: string): Promise<void> {
  const set = sessionTempFiles.get(sessionId)
  if (!set) return
  sessionTempFiles.delete(sessionId)
  await Promise.all(Array.from(set).map((p) => deleteTempFile(p)))
}
