import fs from 'node:fs'

// Nightly builds synthesize a `<upcoming>-nightly.<YYYYMMDD>.<shortsha>` version
// (detected from a release/v* branch, or patch-bumped from current) and may
// write it to only a subset of the three version sources (or pass it via
// Tauri config overrides), so the strict 3-source equality guard is bypassed
// for nightly. Stable and Insider RC tags keep the strict guard.
const nightlyBypass =
  process.argv.slice(2).includes('--nightly') ||
  process.env.TERMUL_NIGHTLY === '1' ||
  process.env.NIGHTLY === '1'

const tagVersion = process.env.TAG_VERSION
if (!tagVersion) {
  if (nightlyBypass) {
    console.log('ℹ️ Nightly bypass active: TAG_VERSION unset, skipping version alignment.')
    process.exit(0)
  }
  throw new Error('TAG_VERSION environment variable is not set')
}

if (nightlyBypass) {
  console.log(`ℹ️ Nightly bypass active: skipping strict 3-source version guard for ${tagVersion}.`)
  process.exit(0)
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
if (pkg.version !== tagVersion) {
  throw new Error(`package.json version ${pkg.version} does not match tag ${tagVersion}`)
}

const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8')
const cargoMatch = cargo.match(/^version\s*=\s*"([^"]+)"/m)
if (!cargoMatch || cargoMatch[1] !== tagVersion) {
  const cargoVersion = cargoMatch?.[1] ?? 'missing'
  throw new Error(
    `src-tauri/Cargo.toml version ${cargoVersion} ` + `does not match tag ${tagVersion}`
  )
}

const tauri = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'))
if (tauri.version !== tagVersion) {
  throw new Error(
    `src-tauri/tauri.conf.json version ${tauri.version} ` + `does not match tag ${tagVersion}`
  )
}

console.log(`✅ All versions aligned: ${tagVersion}`)
