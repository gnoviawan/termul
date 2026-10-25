/**
 * The window `dialog-check.ts` drives: once mounted it opens GPUI's file
 * dialogs one after another, the way the desktop host does (`openFiles`,
 * then `saveFile`, then an open the driver cancels), and writes what each
 * resolved to, or the error it rejected with, to `<dir>/result.json`.
 *
 * bun tools/native/dialog-scene.tsx <dir> <save-dir>
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { render, useGpuixRequired } from '@gpuix/react'
import { useEffect } from 'react'
import type { PathPrompter } from '../../src/launcher/file-dialogs'

const [dir, saveDir] = process.argv.slice(2)

async function settle<T>(prompt: () => Promise<T>): Promise<{ value: T } | { error: string }> {
  try {
    return { value: await prompt() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function App() {
  const renderer = useGpuixRequired() as unknown as PathPrompter
  useEffect(() => {
    void (async () => {
      const open = await settle(() => renderer.promptForPaths({ files: true, multiple: false }))
      const save = await settle(async () => {
        if (!renderer.promptForNewPath) throw new Error('no promptForNewPath')
        return renderer.promptForNewPath({
          directory: saveDir as string,
          suggestedName: 'app.conf'
        })
      })
      const cancel = await settle(() => renderer.promptForPaths({ files: true }))
      writeFileSync(path.join(dir as string, 'result.json'), JSON.stringify({ open, save, cancel }))
      process.exit(0)
    })()
  }, [renderer])
  return <div style={{ width: '100%', height: '100%', backgroundColor: '#000000' }} />
}

if (dir) render(<App />, { title: 'termul-dialog-check', width: 320, height: 200, focus: false })
