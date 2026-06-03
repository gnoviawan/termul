#!/usr/bin/env node
/**
 * Fetch the ripgrep sidecar binary/binaries used by the Tauri `externalBin`
 * config (`bin/rg`). The binaries are NOT committed to git; they are downloaded
 * from the official ripgrep releases at build time so the repository stays small.
 *
 * Resolution order for which target(s) to fetch:
 *   1. CLI args:   `node scripts/fetch-rg.mjs <triple> [<triple> ...]`
 *                  `node scripts/fetch-rg.mjs --all`     (every known target)
 *   2. Env:        RG_TARGETS=triple1,triple2
 *   3. Env:        TAURI_ENV_TARGET_TRIPLE  (set by Tauri in build hooks)
 *   4. Host triple via `rustc --print host-tuple`
 *
 * Idempotent: a target is skipped if its binary already exists and the version
 * marker matches RG_VERSION. Pass `--force` to re-download.
 *
 * Requires Node 18+ (global fetch) or Bun, plus `tar` on PATH (bsdtar on
 * macOS/Windows extracts the .zip; GNU tar handles the .tar.gz on Linux).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RG_VERSION = '15.1.0';
const BASE_URL = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = join(ROOT, 'src-tauri', 'bin');
const VERSION_MARKER = join(BIN_DIR, '.rg-version');

/**
 * Map a Tauri/Rust target triple to the ripgrep release asset that ships a
 * compatible binary. ripgrep does not publish an x86_64 linux-gnu build, so
 * both linux x86_64 triples use the statically linked musl asset.
 */
const ASSET_TRIPLE = {
  'aarch64-apple-darwin': 'aarch64-apple-darwin',
  'x86_64-apple-darwin': 'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc': 'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc': 'aarch64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu': 'x86_64-unknown-linux-musl',
  'x86_64-unknown-linux-musl': 'x86_64-unknown-linux-musl',
  'aarch64-unknown-linux-gnu': 'aarch64-unknown-linux-gnu',
};

const KNOWN_TARGETS = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
  'x86_64-unknown-linux-musl',
];

function isWindows(triple) {
  return triple.includes('windows');
}

function hostTriple() {
  try {
    return execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
  } catch {
    // rustc < 1.84.0 has no `host-tuple`; parse verbose output instead.
    try {
      const out = execFileSync('rustc', ['-Vv'], { encoding: 'utf8' });
      const line = out.split('\n').find((l) => l.startsWith('host:'));
      if (line) return line.split(':')[1].trim();
    } catch {
      /* fall through */
    }
  }
  throw new Error(
    'Could not determine the host target triple. Install Rust (rustc) or pass a triple explicitly, e.g. `node scripts/fetch-rg.mjs aarch64-apple-darwin`.',
  );
}

function resolveTargets(argv) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = argv.filter((a) => !a.startsWith('--'));

  if (flags.includes('--all')) return [...KNOWN_TARGETS];
  if (positional.length > 0) return positional;
  if (process.env.RG_TARGETS) {
    return process.env.RG_TARGETS.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return [process.env.TAURI_ENV_TARGET_TRIPLE];
  return [hostTriple()];
}

async function download(url) {
  if (typeof fetch === 'undefined') {
    throw new Error('Global fetch is unavailable. Use Node 18+ or Bun to run this script.');
  }
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed (${res.status} ${res.statusText}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function fetchTarget(triple, { force }) {
  const assetTriple = ASSET_TRIPLE[triple];
  if (!assetTriple) {
    throw new Error(
      `Unsupported target triple: ${triple}. Known targets:\n  ${Object.keys(ASSET_TRIPLE).join('\n  ')}`,
    );
  }

  const exe = isWindows(triple) ? '.exe' : '';
  const outPath = join(BIN_DIR, `rg-${triple}${exe}`);

  const markerMatches = existsSync(VERSION_MARKER) && readFileSync(VERSION_MARKER, 'utf8').trim() === RG_VERSION;
  if (!force && existsSync(outPath) && markerMatches) {
    console.log(`✓ rg-${triple}${exe} already present (v${RG_VERSION})`);
    return;
  }

  const isZip = isWindows(assetTriple);
  const archiveName = `ripgrep-${RG_VERSION}-${assetTriple}.${isZip ? 'zip' : 'tar.gz'}`;
  const archiveUrl = `${BASE_URL}/${archiveName}`;

  console.log(`↓ downloading ${archiveName} → rg-${triple}${exe}`);
  const [archive, checksum] = await Promise.all([
    download(archiveUrl),
    // ripgrep's .sha256 files come in two shapes: the Unix `<hash>  <file>`
    // form and a multi-line Windows CertUtil dump. Pull the 64-char hex digest
    // out of whichever we get.
    download(`${archiveUrl}.sha256`).then((b) => {
      const match = b.toString('utf8').match(/\b[0-9a-f]{64}\b/i);
      if (!match) throw new Error(`Could not parse sha256 for ${archiveName}`);
      return match[0].toLowerCase();
    }),
  ]);

  const actual = sha256(archive);
  if (actual !== checksum) {
    throw new Error(`Checksum mismatch for ${archiveName}\n  expected: ${checksum}\n  actual:   ${actual}`);
  }

  const tmp = mkdtempSync(join(tmpdir(), 'rg-fetch-'));
  try {
    const archivePath = join(tmp, archiveName);
    writeFileSync(archivePath, archive);
    // bsdtar (macOS/Windows) and GNU tar both extract the formats we fetch.
    const tarArgs = isZip ? ['-xf', archivePath, '-C', tmp] : ['-xzf', archivePath, '-C', tmp];
    execFileSync('tar', tarArgs, { stdio: 'inherit' });

    const innerBin = join(tmp, `ripgrep-${RG_VERSION}-${assetTriple}`, isZip ? 'rg.exe' : 'rg');
    if (!existsSync(innerBin)) throw new Error(`Extracted archive is missing ${innerBin}`);

    mkdirSync(BIN_DIR, { recursive: true });
    copyFileSync(innerBin, outPath);
    if (!isWindows(triple)) chmodSync(outPath, 0o755);
    console.log(`✓ rg-${triple}${exe} (v${RG_VERSION})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const targets = [...new Set(resolveTargets(argv))];

  for (const triple of targets) {
    await fetchTarget(triple, { force });
  }
  writeFileSync(VERSION_MARKER, `${RG_VERSION}\n`);
}

main().catch((err) => {
  console.error(`fetch-rg: ${err.message}`);
  process.exit(1);
});
