/**
 * Build `native/webview-host` (the browser-pane helper) and link it next to the bundle, where
 * `src/browser/support.ts` looks for it. `bun build.ts` runs this on Linux; on its own:
 *
 *   bun tools/webview-host.ts            # debug profile
 *   bun tools/webview-host.ts --release
 *
 * Cargo writes to `$CARGO_TARGET_DIR`, defaulting to the repo's `src-tauri/target`, which already
 * holds wry and webkit2gtk from the desktop build. `TERMUL_GPUIX_SKIP_WEBVIEW_HOST=1` skips it.
 */

import { linkSync, rmSync } from 'node:fs'
import path from 'node:path'
import { WEBVIEW_HOST_BIN } from '../src/browser/support'

const APP_DIR = path.resolve(import.meta.dir, '..')
const CRATE = path.join(APP_DIR, 'native/webview-host/Cargo.toml')

export type WebviewHostBuild =
  | { kind: 'built'; binary: string; ms: number }
  | { kind: 'skipped'; reason: string }

export function buildWebviewHost(
  outDir: string,
  options: { release?: boolean } = {}
): WebviewHostBuild {
  if (process.platform !== 'linux')
    return { kind: 'skipped', reason: 'browser panes are Linux only' }
  if (process.env.TERMUL_GPUIX_SKIP_WEBVIEW_HOST === '1') {
    return { kind: 'skipped', reason: 'TERMUL_GPUIX_SKIP_WEBVIEW_HOST=1' }
  }
  if (!Bun.which('cargo')) return { kind: 'skipped', reason: 'cargo is not on PATH' }
  const targetDir = process.env.CARGO_TARGET_DIR || path.resolve(APP_DIR, '../../src-tauri/target')
  const started = performance.now()
  const args = ['build', '--manifest-path', CRATE, ...(options.release ? ['--release'] : [])]
  const result = Bun.spawnSync(['cargo', ...args], {
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
    stdout: 'inherit',
    stderr: 'inherit'
  })
  if (result.exitCode !== 0)
    throw new Error(`cargo ${args.join(' ')} exited with ${result.exitCode}`)
  const built = path.join(targetDir, options.release ? 'release' : 'debug', WEBVIEW_HOST_BIN)
  const binary = path.join(outDir, WEBVIEW_HOST_BIN)
  rmSync(binary, { force: true })
  linkSync(built, binary)
  return { kind: 'built', binary, ms: Math.round(performance.now() - started) }
}

if (import.meta.main) {
  const result = buildWebviewHost(path.join(APP_DIR, 'dist'), {
    release: Bun.argv.includes('--release')
  })
  console.log(
    result.kind === 'built'
      ? `linked ${result.binary} (${result.ms} ms)`
      : `skipped: ${result.reason}`
  )
}
