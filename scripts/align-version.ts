import fs from 'node:fs'

const tagVersion = process.env.TAG_VERSION
if (!tagVersion) {
  throw new Error('TAG_VERSION environment variable is not set')
}

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
if (pkg.version !== tagVersion) {
  throw new Error(
    `package.json version ${pkg.version} does not match tag ${tagVersion}`
  )
}

const cargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8')
const cargoMatch = cargo.match(/^version\s*=\s*"([^"]+)"/m)
if (!cargoMatch || cargoMatch[1] !== tagVersion) {
  const cargoVersion = cargoMatch?.[1] ?? 'missing'
  throw new Error(
    `src-tauri/Cargo.toml version ${cargoVersion} ` +
      `does not match tag ${tagVersion}`
  )
}

const tauri = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'))
if (tauri.version !== tagVersion) {
  throw new Error(
    `src-tauri/tauri.conf.json version ${tauri.version} ` +
      `does not match tag ${tagVersion}`
  )
}

console.log(`✅ All versions aligned: ${tagVersion}`)