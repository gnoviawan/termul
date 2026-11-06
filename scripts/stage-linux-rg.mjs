#!/usr/bin/env node

// Linux `beforeBundleCommand` (see `src-tauri/tauri.linux.conf.json`).
//
// Linux packages must not ship ripgrep through `bundle.externalBin`: Tauri
// installs external binaries next to the app in `/usr/bin`, and `/usr/bin/rg`
// is owned by the distro `ripgrep` package, so dpkg refuses to install Termul
// next to it (gh-1575). Instead the deb/rpm/AppImage configs copy one fixed
// file to `/usr/lib/termul-manager/rg`. That `files` entry cannot name the
// target triple, so this hook copies `src-tauri/bin/rg-<triple>` to a stable,
// git-ignored staging path before the bundler runs. The Tauri CLI exports the
// build's target triple as `TAURI_ENV_TARGET_TRIPLE` to every hook.

import { chmod, copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_SRC_TAURI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri')

// Must match the `files` sources in `src-tauri/tauri.linux.conf.json`
// (relative to `src-tauri/`, the bundler's working directory).
export const STAGED_RG_RELATIVE_PATH = join('bin', 'linux-package', 'rg')

export async function stageLinuxRg({ targetTriple, srcTauriDir = DEFAULT_SRC_TAURI_DIR }) {
  if (typeof targetTriple !== 'string' || targetTriple.trim() === '') {
    throw new Error(
      'TAURI_ENV_TARGET_TRIPLE is not set; run this through the Tauri CLI (beforeBundleCommand)'
    )
  }
  if (!targetTriple.includes('linux')) {
    throw new Error(`refusing to stage ripgrep for non-Linux target ${targetTriple}`)
  }

  const source = join(srcTauriDir, 'bin', `rg-${targetTriple}`)
  const sourceStat = await stat(source).catch(() => null)
  if (!sourceStat?.isFile()) {
    throw new Error(`bundled ripgrep for ${targetTriple} is missing: ${source}`)
  }

  const destination = join(srcTauriDir, STAGED_RG_RELATIVE_PATH)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
  await chmod(destination, 0o755)
  return { source, destination }
}

async function main() {
  const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE
  try {
    const { source, destination } = await stageLinuxRg({ targetTriple })
    console.log(
      `[stage-linux-rg] staged ${relative(process.cwd(), source)} -> ${relative(process.cwd(), destination)}`
    )
  } catch (error) {
    console.error(`[stage-linux-rg] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
