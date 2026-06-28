import { invoke } from '@tauri-apps/api/core'

/**
 * Read attachment image bytes through the validated `read_attachment_bytes`
 * Tauri command. This is the only brokered binary-read path in the renderer:
 * the generic `fs:allow-read-file` permission was removed from the default
 * capability, so attachment previews go through one size- and type-constrained
 * command instead of the raw fs plugin. The command rejects non-image paths,
 * non-regular files, and files over the 10 MB attachment cap.
 *
 * Returns raw bytes; the caller base64-encodes them for `data:` URL previews.
 */
export async function readAttachmentBytes(path: string): Promise<Uint8Array> {
  const buffer = (await invoke('read_attachment_bytes', { path })) as ArrayBuffer
  return new Uint8Array(buffer)
}
