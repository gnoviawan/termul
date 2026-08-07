import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
// @ts-expect-error The production helper is intentionally plain ESM for direct workflow use.
import { prepareServerArtifacts, SERVER_PLATFORM_KEY } from './prepare-server-artifacts.mjs'

async function fixtureDir() {
  return mkdtemp(join(tmpdir(), 'termul-server-artifacts-'))
}

describe('prepareServerArtifacts', () => {
  test('emits the linux-x86_64-server manifest fragment for the nightly moving tag', async () => {
    const dir = await fixtureDir()
    const sigPath = join(dir, 'termul-server.sig')
    await writeFile(sigPath, 'untrusted comment: ...\nRWSU...\ntrusted comment: ...\nfoo==\n')

    const outPath = join(dir, 'server-manifest.json')
    const manifest = await prepareServerArtifacts({
      signaturePath: sigPath,
      tag: 'nightly',
      version: '0.0.0-nightly.20260807.abc1234',
      outputPath: outPath
    })

    expect(manifest.version).toBe('0.0.0-nightly.20260807.abc1234')
    expect(manifest.assetNames).toEqual(['termul-server', 'termul-server.sig'])
    expect(Object.keys(manifest.platforms)).toEqual([SERVER_PLATFORM_KEY])
    expect(manifest.platforms[SERVER_PLATFORM_KEY].url).toBe(
      'https://github.com/gnoviawan/termul/releases/download/nightly/termul-server'
    )
    // The full minisign signature text is preserved (trimmed).
    expect(manifest.platforms[SERVER_PLATFORM_KEY].signature).toContain('RWSU')
    expect(JSON.parse(await readFile(outPath, 'utf8'))).toEqual(manifest)
  })

  test('targets the versioned tag for stable / insider RC channels', async () => {
    const dir = await fixtureDir()
    const sigPath = join(dir, 'termul-server.sig')
    await writeFile(sigPath, 'sig\n')

    const manifest = await prepareServerArtifacts({
      signaturePath: sigPath,
      tag: 'v0.5.0-rc.1',
      version: '0.5.0-rc.1',
      outputPath: join(dir, 'out.json')
    })

    expect(manifest.platforms[SERVER_PLATFORM_KEY].url).toBe(
      'https://github.com/gnoviawan/termul/releases/download/v0.5.0-rc.1/termul-server'
    )
  })

  test('rejects an empty signature file', async () => {
    const dir = await fixtureDir()
    const sigPath = join(dir, 'empty.sig')
    await writeFile(sigPath, '   ')

    await expect(
      prepareServerArtifacts({
        signaturePath: sigPath,
        tag: 'nightly',
        version: '0.0.0-nightly.1',
        outputPath: join(dir, 'out.json')
      })
    ).rejects.toThrow('signature content must be a nonempty string')
  })
})
