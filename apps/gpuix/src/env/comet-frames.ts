/**
 * The spinner's frame store: each comet frame is a file under `dir`, so a
 * spinner step sends a path instead of 11 KB of SVG (`src/ui/spinner.tsx`).
 * Names carry a content hash, so an existing file is already the right frame.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { setFrameStore } from '../ui/internal/frame-store'

export function installCometFrames(dir: string): void {
  setFrameStore((name, svg) => {
    const file = path.join(dir, name)
    if (existsSync(file)) return file
    mkdirSync(dir, { recursive: true })
    // Another client on the same state dir may write the same frame; rename is atomic.
    const partial = `${file}.${process.pid}`
    writeFileSync(partial, svg)
    renameSync(partial, file)
    return file
  })
}
