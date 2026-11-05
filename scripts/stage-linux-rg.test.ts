import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
// @ts-expect-error The production helper is intentionally plain ESM for direct hook use.
import { STAGED_RG_RELATIVE_PATH, stageLinuxRg } from './stage-linux-rg.mjs'

async function srcTauriFixture(triples: string[]) {
  const srcTauriDir = await mkdtemp(join(tmpdir(), 'termul-stage-rg-'))
  await mkdir(join(srcTauriDir, 'bin'), { recursive: true })
  for (const triple of triples) {
    await writeFile(join(srcTauriDir, 'bin', `rg-${triple}`), `rg for ${triple}`)
  }
  return srcTauriDir
}

describe('stageLinuxRg', () => {
  test('copies the target-triple ripgrep to the fixed Linux package source path', async () => {
    const srcTauriDir = await srcTauriFixture([
      'x86_64-unknown-linux-gnu',
      'aarch64-unknown-linux-gnu'
    ])

    const { destination } = await stageLinuxRg({
      targetTriple: 'aarch64-unknown-linux-gnu',
      srcTauriDir
    })

    expect(destination).toBe(join(srcTauriDir, STAGED_RG_RELATIVE_PATH))
    expect(await readFile(destination, 'utf8')).toBe('rg for aarch64-unknown-linux-gnu')
    if (process.platform !== 'win32') {
      expect((await stat(destination)).mode & 0o777).toBe(0o755)
    }
  })

  test('the staged path matches every files source in tauri.linux.conf.json', async () => {
    const config = JSON.parse(
      await readFile(join(__dirname, '..', 'src-tauri', 'tauri.linux.conf.json'), 'utf8')
    )
    expect(config.build.beforeBundleCommand).toBe('node scripts/stage-linux-rg.mjs')
    for (const pkg of ['deb', 'rpm', 'appimage']) {
      const sources = Object.values(config.bundle.linux[pkg].files)
      expect(sources).toEqual([STAGED_RG_RELATIVE_PATH.split('\\').join('/')])
    }
  })

  test('fails loudly when the bundled ripgrep for the target is missing', async () => {
    const srcTauriDir = await srcTauriFixture(['x86_64-unknown-linux-gnu'])

    await expect(
      stageLinuxRg({ targetTriple: 'aarch64-unknown-linux-gnu', srcTauriDir })
    ).rejects.toThrow(/bundled ripgrep for aarch64-unknown-linux-gnu is missing/)
  })

  test('rejects a missing or non-Linux target triple', async () => {
    const srcTauriDir = await srcTauriFixture(['x86_64-apple-darwin'])

    await expect(stageLinuxRg({ targetTriple: undefined, srcTauriDir })).rejects.toThrow(
      /TAURI_ENV_TARGET_TRIPLE is not set/
    )
    await expect(
      stageLinuxRg({ targetTriple: 'x86_64-apple-darwin', srcTauriDir })
    ).rejects.toThrow(/non-Linux target/)
  })
})
