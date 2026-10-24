/**
 * Files for the shared attachment path: `FileReader`, which Bun lacks, and
 * the `File`s an OS drop hands to `dataTransfer.files`. A dropped path opens
 * lazily (`Bun.file`), so a large file is read only if the drop zone reads
 * it, and carries the type and name a browser would give it.
 */

import { statSync } from 'node:fs'
import path from 'node:path'
import { setDroppedFileOpener } from '../compat/dnd'
import { log } from '../log'

type ReadResult = string | ArrayBuffer

/** The MIME type a browser reports: no parameters, and none for unknown bytes. */
export function browserFileType(bunType: string): string {
  const type = bunType.split(';')[0].trim()
  return type === 'application/octet-stream' ? '' : type
}

export function openDroppedFile(filePath: string): File {
  const name = path.basename(filePath)
  try {
    const stat = statSync(filePath)
    if (stat.isDirectory()) return new File([], name, { lastModified: stat.mtimeMs })
    const blob = Bun.file(filePath)
    return new File([blob], name, { type: browserFileType(blob.type), lastModified: stat.mtimeMs })
  } catch (error) {
    log.warn(
      'dnd',
      `dropped path unreadable: ${error instanceof Error ? error.message : String(error)}`
    )
    return new File([], name)
  }
}

type Handler = ((event: Event) => void) | null

export class BlobFileReader extends EventTarget {
  static readonly EMPTY = 0
  static readonly LOADING = 1
  static readonly DONE = 2
  readyState = 0
  result: ReadResult | null = null
  error: Error | null = null
  onload: Handler = null
  onerror: Handler = null
  onloadend: Handler = null
  onloadstart: Handler = null
  onabort: Handler = null
  onprogress: Handler = null

  readAsText(blob: Blob): void {
    this.read(blob.text())
  }

  readAsArrayBuffer(blob: Blob): void {
    this.read(blob.arrayBuffer())
  }

  readAsDataURL(blob: Blob): void {
    this.read(
      blob
        .arrayBuffer()
        .then(
          (bytes) =>
            `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(bytes).toString('base64')}`
        )
    )
  }

  abort(): void {}

  private read(pending: Promise<ReadResult>): void {
    this.readyState = BlobFileReader.LOADING
    this.emit('loadstart')
    pending.then(
      (result) => {
        this.result = result
        this.readyState = BlobFileReader.DONE
        this.emit('load')
        this.emit('loadend')
      },
      (error: unknown) => {
        this.error = error instanceof Error ? error : new Error(String(error))
        this.readyState = BlobFileReader.DONE
        this.emit('error')
        this.emit('loadend')
      }
    )
  }

  private emit(type: 'loadstart' | 'load' | 'error' | 'loadend'): void {
    const event = new Event(type)
    this[`on${type}`]?.(event)
    this.dispatchEvent(event)
  }
}

export function installFiles(g: Record<string, unknown>): void {
  if (g.FileReader === undefined) g.FileReader = BlobFileReader
  setDroppedFileOpener(openDroppedFile)
}
