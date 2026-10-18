import { readFileSync } from 'node:fs'

const FIELDS = ['tag', 'url', 'sha256']

export function parsePin(text) {
  const pin = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    const eq = line.indexOf('=')
    if (eq <= 0) throw new Error(`figcraft.pin: malformed line "${line}"`)
    const key = line.slice(0, eq)
    if (!FIELDS.includes(key)) throw new Error(`figcraft.pin: unknown field "${key}"`)
    if (key in pin) throw new Error(`figcraft.pin: duplicate field "${key}"`)
    pin[key] = line.slice(eq + 1)
  }
  for (const key of FIELDS) {
    if (!pin[key]) throw new Error(`figcraft.pin: missing field "${key}"`)
  }
  if (!/^[0-9a-f]{64}$/.test(pin.sha256)) {
    throw new Error('figcraft.pin: sha256 must be 64 lowercase hex characters')
  }
  if (!pin.url.startsWith('https://')) throw new Error('figcraft.pin: url must be https')
  return pin
}

export function readPin(path) {
  return parsePin(readFileSync(path, 'utf8'))
}

/**
 * The git ref the `figcraft-mcp` dependency pins, `{ kind: 'tag' | 'rev', value }`,
 * or `null` when Cargo.toml has no such dependency. A dependency pinned by
 * neither (a branch, a path) is an error: it is not reproducible.
 */
export function cargoFigcraftMcpRef(cargoToml) {
  for (const line of cargoToml.split(/\r?\n/)) {
    if (!/^\s*figcraft-mcp\s*=/.test(line)) continue
    const tag = /\btag\s*=\s*"([^"]+)"/.exec(line)
    if (tag) return { kind: 'tag', value: tag[1] }
    const rev = /\brev\s*=\s*"([^"]+)"/.exec(line)
    if (rev) return { kind: 'rev', value: rev[1] }
    throw new Error('Cargo.toml: figcraft-mcp dependency has no tag or rev')
  }
  return null
}
