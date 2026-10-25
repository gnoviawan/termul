/**
 * Build the Linux x64 package of the GPUIX desktop app: `bun run package:linux`.
 *
 *   bun packaging/linux/package.ts [--out DIR] [--server-bin FILE] [--webview-host FILE]
 *
 * The package is a directory app under /opt/termul-gpuix: the Bun runtime that runs this script,
 * the production client bundle, its fonts, the four runtime packages it leaves external
 * (react, react-dom, @gpuix/react, @gpuix/native with its Linux addon), termul-server built from
 * this tree (release, standalone-server), ripgrep, and the browser-pane webview helper. A
 * `/usr/bin/termul-gpuix` link, a .desktop entry and hicolor icons go beside it, and
 * `dpkg-deb` packs it all as DIR/termul-gpuix_<version>_amd64.deb (default DIR: dist-package/).
 *
 * `--server-bin` and `--webview-host` take prebuilt binaries instead of running cargo. Cargo uses
 * `$CARGO_TARGET_DIR`, else `src-tauri/target`. The server build embeds `dist-web/`; without
 * `--server-bin` this runs `bun run build:web` first when the repo has no `dist-web/` yet, or
 * always with `--rebuild-web`.
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { APP_DIR, buildClient, ENTRY, REPO_DIR } from '../../build'
import { WEBVIEW_HOST_BIN } from '../../src/browser/support'
import {
  APP_ID,
  controlFile,
  desktopEntry,
  ICONS,
  INSTALL_DIR,
  PACKAGE_NAME,
  RIPGREP_SOURCE,
  WRAPPER
} from './layout'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: 'string', default: path.join(APP_DIR, 'dist-package') },
    'server-bin': { type: 'string' },
    'webview-host': { type: 'string' },
    'keep-stage': { type: 'boolean', default: false },
    'rebuild-web': { type: 'boolean', default: false }
  }
})

const VERSION: string = (await Bun.file(path.join(REPO_DIR, 'package.json')).json()).version
const OUT = path.resolve(values.out!)
const STAGE = path.join(OUT, 'stage')
const ROOT = path.join(STAGE, INSTALL_DIR)
const DIST = path.join(ROOT, 'dist')
const TARGET_DIR = process.env.CARGO_TARGET_DIR || path.join(REPO_DIR, 'src-tauri/target')
/** Cargo release builds can add gigabytes; stop before the disk gets tight. */
const MIN_FREE_BYTES = 8 * 1024 ** 3

const started = performance.now()
function step(message: string): void {
  console.log(`[package] ${((performance.now() - started) / 1000).toFixed(1)}s ${message}`)
}

function run(cmd: string[], options: { cwd?: string; env?: Record<string, string> } = {}): void {
  const result = Bun.spawnSync(cmd, {
    cwd: options.cwd ?? REPO_DIR,
    env: { ...process.env, ...options.env },
    stdout: 'inherit',
    stderr: 'inherit'
  })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')} exited with ${result.exitCode}`)
}

function requireTool(name: string): void {
  if (!Bun.which(name)) throw new Error(`${name} is not on PATH`)
}

function freeBytes(dir: string): number {
  const stats = statfsSync(dir)
  return stats.bavail * stats.bsize
}

function cargoRelease(manifest: string, bin: string, features: string[] = []): string {
  const free = freeBytes(path.dirname(TARGET_DIR))
  if (free < MIN_FREE_BYTES) {
    throw new Error(
      `${(free / 1024 ** 3).toFixed(1)} GiB free, below ${MIN_FREE_BYTES / 1024 ** 3} GiB; free disk or pass --server-bin/--webview-host`
    )
  }
  run(
    [
      'cargo',
      'build',
      '--release',
      '--manifest-path',
      manifest,
      '--bin',
      bin,
      ...(features.length ? ['--features', features.join(',')] : [])
    ],
    // From the crate's own dir, like `cd src-tauri && cargo` and the Tauri CLI: cargo reads
    // `.cargo/config.toml` from the cwd up, and `src-tauri/` plus the repo root give different
    // rustflags than the root alone, so another cwd recompiles every crate in a shared target.
    { cwd: path.dirname(manifest), env: { CARGO_TARGET_DIR: TARGET_DIR } }
  )
  return path.join(TARGET_DIR, 'release', bin)
}

/** Copies, then strips the copy: strip replaces the file, so a cargo artifact is never touched. */
function installElf(source: string, dest: string): void {
  if (!statSync(source).isFile()) throw new Error(`${source} is not a file`)
  mkdirSync(path.dirname(dest), { recursive: true })
  copyFileSync(source, dest)
  chmodSync(dest, 0o755)
  run(['strip', '--strip-unneeded', dest])
}

function dirBytes(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += statSync(path.join(entry.parentPath, entry.name)).size
  }
  return total
}

const mib = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MiB`

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(
    `the Linux package builds on linux x64 only (this is ${process.platform} ${process.arch})`
  )
}
for (const tool of [
  'dpkg-deb',
  'strip',
  ...(values['server-bin'] && values['webview-host'] ? [] : ['cargo'])
]) {
  requireTool(tool)
}

rmSync(STAGE, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })

step('client bundle')
const client = await buildClient(ENTRY, DIST, { production: true })
for (const line of client.logs) console.error(line)
if (!client.ok) throw new Error('client bundle failed')
const updateCheck = await Bun.build({
  entrypoints: [path.join(import.meta.dir, '../update-check.ts')],
  outdir: DIST,
  naming: 'check-update.js',
  target: 'bun',
  minify: true,
  define: { 'import.meta.env.PACKAGE_VERSION': JSON.stringify(VERSION) }
})
if (!updateCheck.success) throw new Error(updateCheck.logs.map(String).join('\n'))
for (const file of readdirSync(DIST)) if (file.endsWith('.map')) rmSync(path.join(DIST, file))
cpSync(path.join(APP_DIR, 'assets/fonts'), path.join(ROOT, 'assets/fonts'), { recursive: true })

step('runtime packages')
copyFileSync(path.join(APP_DIR, 'package.json'), path.join(ROOT, 'package.json'))
copyFileSync(path.join(APP_DIR, 'bun.lock'), path.join(ROOT, 'bun.lock'))
run(
  ['bun', 'install', '--production', '--frozen-lockfile', '--ignore-scripts', '--backend=copyfile'],
  {
    cwd: ROOT
  }
)
rmSync(path.join(ROOT, 'bun.lock'))
// The browser (wasm) build of @gpuix/native: the desktop app loads the .node addon.
rmSync(path.join(ROOT, 'node_modules/@gpuix/native/wasm'), { recursive: true })
writeFileSync(
  path.join(ROOT, 'package.json'),
  `${JSON.stringify({ name: PACKAGE_NAME, version: VERSION, private: true, type: 'module' }, null, 2)}\n`
)
writeFileSync(
  path.join(ROOT, 'bunfig.toml'),
  '# Empty: keeps a bunfig.toml in the working directory out of the app.\n'
)
copyFileSync(process.execPath, path.join(ROOT, 'bun'))
chmodSync(path.join(ROOT, 'bun'), 0o755)
const addon = path.join(
  ROOT,
  'node_modules/@gpuix/native-linux-x64-gnu/gpuix-native.linux-x64-gnu.node'
)
run(['strip', '--strip-unneeded', addon])

step('termul-server')
let serverBin = values['server-bin']
if (!serverBin) {
  // The server embeds dist-web/ for browsers; the GPUIX client never loads it, so an existing
  // bundle is reused (rebuilding it changes its mtimes and recompiles the server crate).
  if (values['rebuild-web'] || !existsSync(path.join(REPO_DIR, 'dist-web/index.html'))) {
    run(['bun', 'run', 'build:web'])
  }
  serverBin = cargoRelease(path.join(REPO_DIR, 'src-tauri/Cargo.toml'), 'termul-server', [
    'standalone-server'
  ])
}
installElf(serverBin, path.join(DIST, 'termul-server'))
installElf(path.join(REPO_DIR, RIPGREP_SOURCE), path.join(DIST, 'rg'))

step('webview host')
const hostBin =
  values['webview-host'] ??
  cargoRelease(path.join(APP_DIR, 'native/webview-host/Cargo.toml'), WEBVIEW_HOST_BIN)
installElf(hostBin, path.join(DIST, WEBVIEW_HOST_BIN))

step('wrapper, desktop entry, icons')
writeFileSync(path.join(ROOT, PACKAGE_NAME), WRAPPER.replaceAll('@VERSION@', VERSION), {
  mode: 0o755
})
mkdirSync(path.join(STAGE, 'usr/bin'), { recursive: true })
symlinkSync(
  path.relative(path.join(STAGE, 'usr/bin'), path.join(ROOT, PACKAGE_NAME)),
  path.join(STAGE, 'usr/bin', PACKAGE_NAME)
)
mkdirSync(path.join(STAGE, 'usr/share/applications'), { recursive: true })
writeFileSync(path.join(STAGE, 'usr/share/applications', `${APP_ID}.desktop`), desktopEntry())
for (const icon of ICONS) {
  const dir = path.join(STAGE, 'usr/share/icons/hicolor', icon.size, 'apps')
  mkdirSync(dir, { recursive: true })
  copyFileSync(path.join(REPO_DIR, icon.source), path.join(dir, `${PACKAGE_NAME}.png`))
}
const docDir = path.join(STAGE, 'usr/share/doc', PACKAGE_NAME)
mkdirSync(docDir, { recursive: true })
copyFileSync(
  path.join(APP_DIR, 'THIRD_PARTY_NOTICES.md'),
  path.join(docDir, 'THIRD_PARTY_NOTICES.md')
)

step('dpkg-deb')
const installedBytes = dirBytes(STAGE)
mkdirSync(path.join(STAGE, 'DEBIAN'))
writeFileSync(
  path.join(STAGE, 'DEBIAN/control'),
  controlFile({ version: VERSION, installedKb: Math.ceil(installedBytes / 1024) })
)
const deb = path.join(OUT, `${PACKAGE_NAME}_${VERSION}_amd64.deb`)
rmSync(deb, { force: true })
run(['dpkg-deb', '--build', '--root-owner-group', '-Zxz', STAGE, deb])
if (!values['keep-stage']) rmSync(STAGE, { recursive: true })

console.log(
  JSON.stringify({
    deb,
    debBytes: statSync(deb).size,
    debSize: mib(statSync(deb).size),
    installed: mib(installedBytes),
    seconds: Math.round((performance.now() - started) / 1000)
  })
)
