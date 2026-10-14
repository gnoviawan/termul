import type { SFTPEntry, SFTPTransferProgress } from '@shared/types/ssh.types'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { joinPath } from '@/hooks/use-sftp-browser'
import { dialogApi, sshApi } from '@/lib/api'
import { deleteTempFile } from '@/lib/attachment-temp-cleanup'
import { writeBytesToTempFile } from '@/lib/composer-attachments-io'
import { logFrontendError } from '@/lib/log-api'
import { useSSHStore } from '@/stores/ssh-store'

/**
 * A file to upload: a local path (Upload button) or a dropped `File`. The
 * window keeps native drag-drop off, so a drop carries bytes, not a path.
 */
export type UploadSource = { kind: 'path'; path: string } | { kind: 'file'; file: File }

/** Upload picked files that already exist in the folder: asked before replacing. */
export interface PendingReplace {
  dir: string
  sources: UploadSource[]
  /** Remote names that would be replaced. */
  conflicts: string[]
}

/**
 * A dropped file is read into memory before it is staged in a temp file, so
 * very large ones are refused (the Upload button streams from disk instead).
 */
export const MAX_DROP_BYTES = 512 * 1024 * 1024

type TransferBase = Omit<
  SFTPTransferProgress,
  'bytesTransferred' | 'totalBytes' | 'status' | 'error'
>

/** Last segment of a local path (Windows or POSIX separators). */
export function localFileName(localPath: string): string {
  return localPath.split(/[\\/]/).filter(Boolean).pop() ?? localPath
}

export function sourceName(source: UploadSource): string {
  return source.kind === 'path' ? localFileName(source.path) : source.file.name
}

function record(progress: SFTPTransferProgress): void {
  useSSHStore.getState().updateTransferProgress(progress)
}

/** A dropped file that never reached the server (too large, a folder, temp write failed). */
function recordDropFailure(base: TransferBase, error: string, detail: string): void {
  record({ ...base, bytesTransferred: 0, totalBytes: 0, status: 'failed', error })
  void logFrontendError({
    level: 'warn',
    source: 'sftp.transfer',
    message: `SFTP upload failed before sending: ${localFileName(base.remotePath)}: ${detail}`
  })
}

/**
 * Runs one transfer. A pending row goes in first: the backend's first progress
 * event only arrives after a full chunk, and none at all when the file cannot
 * be opened. The final row is written here too, so a failure before the
 * backend knew the size still shows.
 */
async function runTransfer(
  base: TransferBase,
  run: () => Promise<{ success: true } | { success: false; error: string }>
): Promise<boolean> {
  const name = localFileName(base.remotePath)
  record({ ...base, bytesTransferred: 0, totalBytes: 0, status: 'in-progress' })
  void logFrontendError({
    level: 'info',
    source: 'sftp.transfer',
    message: `SFTP ${base.direction} started: ${name}`
  })
  const result = await run()
  // The backend's last event carries the real byte counts; keep them.
  const last = useSSHStore
    .getState()
    .transfers.find(
      (t) =>
        t.connectionId === base.connectionId &&
        t.remotePath === base.remotePath &&
        t.direction === base.direction
    )
  const bytes = last?.bytesTransferred ?? 0
  const total = last?.totalBytes ?? 0
  if (result.success) {
    record({ ...base, bytesTransferred: total || bytes, totalBytes: total, status: 'completed' })
    void logFrontendError({
      level: 'info',
      source: 'sftp.transfer',
      message: `SFTP ${base.direction} completed: ${name}`
    })
    return true
  }
  record({
    ...base,
    bytesTransferred: bytes,
    totalBytes: total,
    status: 'failed',
    error: result.error
  })
  void logFrontendError({
    level: 'warn',
    source: 'sftp.transfer',
    message: `SFTP ${base.direction} failed: ${name}: ${result.error}`
  })
  return false
}

/**
 * Send a dropped file: stage its bytes in a temp file, upload that, then
 * delete the temp file whatever happened.
 */
async function uploadDropped(base: TransferBase, file: File): Promise<boolean> {
  if (file.size > MAX_DROP_BYTES) {
    recordDropFailure(base, 'Too large to drop. Use Upload instead.', `${file.size} bytes`)
    return false
  }
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch (error) {
    // A dropped folder arrives as a File that cannot be read.
    recordDropFailure(base, "Folders can't be uploaded. Drop the files inside it.", String(error))
    return false
  }
  let tempPath: string
  try {
    tempPath = await writeBytesToTempFile(bytes, file.name)
  } catch (error) {
    recordDropFailure(base, "Couldn't prepare the file for upload.", String(error))
    return false
  }
  try {
    return await runTransfer(base, () =>
      sshApi.sftpUpload(base.connectionId, tempPath, base.remotePath)
    )
  } finally {
    void deleteTempFile(tempPath)
  }
}

/**
 * Upload and download for one SFTP connection. Uploads ask before replacing
 * files that already exist in the folder; downloads ask where to save (the
 * OS dialog confirms overwriting a local file).
 */
export function useSftpTransfers(
  connectionId: string,
  { onUploaded }: { onUploaded: (dir: string) => void }
) {
  const [pendingReplace, setPendingReplace] = useState<PendingReplace | null>(null)

  const startUploads = useCallback(
    async (dir: string, sources: UploadSource[]) => {
      let uploaded = 0
      // One at a time over the session's SFTP channel (and one dropped file in
      // memory at a time); every row shows as queued first.
      for (const source of sources) {
        record({
          connectionId,
          localPath: source.kind === 'path' ? source.path : source.file.name,
          remotePath: joinPath(dir, sourceName(source)),
          direction: 'upload',
          bytesTransferred: 0,
          totalBytes: 0,
          status: 'in-progress'
        })
      }
      for (const source of sources) {
        const remotePath = joinPath(dir, sourceName(source))
        const ok =
          source.kind === 'path'
            ? await runTransfer(
                { connectionId, localPath: source.path, remotePath, direction: 'upload' },
                () => sshApi.sftpUpload(connectionId, source.path, remotePath)
              )
            : await uploadDropped(
                { connectionId, localPath: source.file.name, remotePath, direction: 'upload' },
                source.file
              )
        if (ok) uploaded++
      }
      if (uploaded > 0) onUploaded(dir)
    },
    [connectionId, onUploaded]
  )

  /** Upload now, or ask first when some names already exist in `dir`. */
  const queueUploads = useCallback(
    async (dir: string, entries: SFTPEntry[], sources: UploadSource[]) => {
      const names = sources.map(sourceName)
      // Two different files with one name (dropped from search results, say)
      // would land on the same remote path, the second silently replacing
      // the first: refuse the batch instead.
      const duplicate = names.find((name, i) => names.indexOf(name) !== i)
      if (duplicate !== undefined) {
        toast.error(
          `Two of the files are named “${duplicate}”. Rename one, then upload them again.`
        )
        void logFrontendError({
          level: 'info',
          source: 'sftp.transfer',
          message: `SFTP upload refused: duplicate name in batch: ${duplicate}`
        })
        return
      }
      const existing = new Set(entries.map((e) => e.name))
      const conflicts = names.filter((name) => existing.has(name))
      if (conflicts.length > 0) {
        setPendingReplace({ dir, sources, conflicts })
        return
      }
      await startUploads(dir, sources)
    },
    [startUploads]
  )

  /** Pick local files and upload them into `dir`, asking first about name clashes. */
  const upload = useCallback(
    async (dir: string, entries: SFTPEntry[]) => {
      const picked = await dialogApi.selectFiles({ title: 'Upload files' })
      if (!picked.success) {
        if (picked.code !== 'CANCELLED') {
          toast.error(`Could not open the file picker: ${picked.error}`)
        }
        return
      }
      await queueUploads(
        dir,
        entries,
        picked.data.map((path): UploadSource => ({ kind: 'path', path }))
      )
    },
    [queueUploads]
  )

  /** Upload files dropped from the OS into `dir`, asking first about name clashes. */
  const uploadFiles = useCallback(
    async (dir: string, entries: SFTPEntry[], files: File[]) => {
      if (files.length === 0) return
      await queueUploads(
        dir,
        entries,
        files.map((file): UploadSource => ({ kind: 'file', file }))
      )
    },
    [queueUploads]
  )

  const confirmReplace = useCallback(() => {
    const pending = pendingReplace
    setPendingReplace(null)
    if (pending) void startUploads(pending.dir, pending.sources)
  }, [pendingReplace, startUploads])

  const cancelReplace = useCallback(() => setPendingReplace(null), [])

  /** Save a remote file to a location the user picks. */
  const download = useCallback(
    async (entry: SFTPEntry) => {
      const target = await dialogApi.saveFile({ title: 'Download', defaultPath: entry.name })
      if (!target.success) {
        if (target.code !== 'CANCELLED') {
          toast.error(`Could not open the save dialog: ${target.error}`)
        }
        return
      }
      const localPath = target.data
      await runTransfer(
        { connectionId, localPath, remotePath: entry.path, direction: 'download' },
        () => sshApi.sftpDownload(connectionId, entry.path, localPath)
      )
    },
    [connectionId]
  )

  return { upload, uploadFiles, download, pendingReplace, confirmReplace, cancelReplace }
}
