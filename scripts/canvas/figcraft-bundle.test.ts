import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
// @ts-expect-error Plain ESM helper shared with the workflow scripts.
import { extractBundle, verifyChecksum } from './fetch-figcraft-bundle.mjs'
// @ts-expect-error Plain ESM helper shared with the workflow scripts.
import { cargoFigcraftMcpRef, parsePin, readPin } from './figcraft-pin.mjs'

const SHA = 'a'.repeat(64)

function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = Buffer.from(name)
    const data = Buffer.from(text)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    locals.push(local, nameBytes, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const centralDir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralDir, eocd])
}

describe('figcraft.pin', () => {
  test('the committed pin parses and names a sha256', () => {
    const pin = parsePin(
      readFileSync(join(__dirname, '..', '..', 'canvas', 'figcraft.pin'), 'utf8')
    )
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(pin.url).toContain(pin.tag.replace(/^v/, ''))
  })

  test('rejects unknown, duplicate, missing and malformed fields', () => {
    const ok = `tag=v1\nurl=https://x.test/b.zip\nsha256=${SHA}\n`
    expect(parsePin(ok).tag).toBe('v1')
    expect(() => parsePin(`${ok}extra=1\n`)).toThrow(/unknown field/)
    expect(() => parsePin(`${ok}tag=v2\n`)).toThrow(/duplicate field/)
    expect(() => parsePin('tag=v1\n')).toThrow(/missing field/)
    expect(() => parsePin(`${ok}garbage\n`)).toThrow(/malformed/)
    expect(() => parsePin(ok.replace(SHA, 'abc'))).toThrow(/sha256/)
  })
})

describe('figcraft-mcp pin check', () => {
  const pinPath = join(__dirname, '..', '..', 'canvas', 'figcraft.pin')

  function checkWith(dependencyLine: string) {
    const dir = mkdtempSync(join(tmpdir(), 'figcraft-pin-check-'))
    const cargo = join(dir, 'Cargo.toml')
    writeFileSync(cargo, `[dependencies]\n${dependencyLine}\n`)
    return spawnSync(
      process.execPath,
      [join(__dirname, 'check-figcraft-pin.mjs'), pinPath, cargo],
      {
        encoding: 'utf8'
      }
    )
  }

  test('reads a tag or a rev from the dependency line, or null while there is none', () => {
    expect(cargoFigcraftMcpRef('[dependencies]\nserde = "1"\n')).toBeNull()
    expect(
      cargoFigcraftMcpRef(
        'figcraft-mcp = { git = "https://github.com/gnoviawan/figcraft", tag = "termul-0.6.0" }\n'
      )
    ).toEqual({ kind: 'tag', value: 'termul-0.6.0' })
    expect(
      cargoFigcraftMcpRef('figcraft-mcp = { git = "https://x.test/f", rev = "d9256cc" }\n')
    ).toEqual({ kind: 'rev', value: 'd9256cc' })
    expect(() => cargoFigcraftMcpRef('figcraft-mcp = { path = "../x" }\n')).toThrow(/no tag or rev/)
  })

  test('the check script skips with a clear message while Cargo.toml has no figcraft-mcp', () => {
    const run = checkWith('serde = "1"')
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(/skipped.*no figcraft-mcp dependency/)
  })

  test('the check script fails when the Cargo tag differs from the pin', () => {
    const run = checkWith('figcraft-mcp = { git = "https://x.test/f", tag = "termul-9.9.9" }')
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/pin mismatch/)
  })

  test('the check script passes when the Cargo tag equals the pin', () => {
    const run = checkWith(
      `figcraft-mcp = { git = "https://x.test/f", tag = "${readPin(pinPath).tag}" }`
    )
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(/pin matches/)
  })

  test('a rev dependency warns that it cannot be compared and passes', () => {
    const run = checkWith('figcraft-mcp = { git = "https://x.test/f", rev = "d9256cc" }')
    expect(run.status).toBe(0)
    expect(run.stderr).toMatch(/pinned by rev d9256cc, not a tag/)
  })

  test("the repository's own Cargo.toml passes the check", () => {
    const run = spawnSync(process.execPath, [join(__dirname, 'check-figcraft-pin.mjs')], {
      encoding: 'utf8'
    })
    expect(run.status).toBe(0)
  })
})

describe('bundle fetch', () => {
  test('a checksum mismatch fails and a match passes', () => {
    const bytes = Buffer.from('bundle')
    const good = createHash('sha256').update(bytes).digest('hex')
    expect(() => verifyChecksum(bytes, good)).not.toThrow()
    expect(() => verifyChecksum(bytes, SHA)).toThrow(/sha256 mismatch/)
  })

  test('extracts the single top-level directory flat into the embed dir', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'figcraft-extract-')), 'bundle')
    const written = extractBundle(
      storedZip({
        'figcraft-web-1/': '',
        'figcraft-web-1/index.html': '<html>',
        'figcraft-web-1/sub/a.js': 'x'
      }),
      out
    )
    expect(written).toBe(2)
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toBe('<html>')
    expect(readFileSync(join(out, 'sub', 'a.js'), 'utf8')).toBe('x')
  })

  test('refuses entries that escape the output directory', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'figcraft-slip-')), 'bundle')
    expect(() =>
      extractBundle(storedZip({ 'b/../../evil.txt': 'x', 'b/ok.txt': 'y' }), out)
    ).toThrow(/escapes the output directory/)
    expect(existsSync(join(out, '..', 'evil.txt'))).toBe(false)
  })

  test('the CLI exits non-zero on a bad checksum and leaves the embed dir untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'figcraft-cli-'))
    const zip = join(dir, 'b.zip')
    writeFileSync(zip, storedZip({ 'b/index.html': '<html>' }))
    const pin = join(dir, 'figcraft.pin')
    writeFileSync(pin, `tag=v1\nurl=https://x.test/b.zip\nsha256=${SHA}\n`)
    const out = join(dir, 'bundle')
    const run = spawnSync(
      process.execPath,
      [join(__dirname, 'fetch-figcraft-bundle.mjs'), '--pin', pin, '--zip', zip, '--out', out],
      { encoding: 'utf8' }
    )
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/sha256 mismatch/)
    expect(existsSync(out)).toBe(false)

    const sha = createHash('sha256').update(readFileSync(zip)).digest('hex')
    writeFileSync(pin, `tag=v1\nurl=https://x.test/b.zip\nsha256=${sha}\n`)
    const ok = spawnSync(
      process.execPath,
      [join(__dirname, 'fetch-figcraft-bundle.mjs'), '--pin', pin, '--zip', zip, '--out', out],
      { encoding: 'utf8' }
    )
    expect(ok.status).toBe(0)
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toBe('<html>')
  })
})
