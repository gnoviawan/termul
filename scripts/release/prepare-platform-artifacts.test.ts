import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
// @ts-expect-error The production helper is intentionally plain ESM for direct workflow use.
import { preparePlatformArtifacts } from './prepare-platform-artifacts.mjs'

async function fixtureDir() {
  return mkdtemp(join(tmpdir(), 'termul-platform-artifacts-'))
}

async function fixtureFile(root: string, relativePath: string, content = 'artifact') {
  const path = join(root, ...relativePath.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}

async function prepare(
  platform: string,
  paths: string[],
  root: string,
  options: { version?: string; tag?: string } = {}
) {
  const version = options.version ?? '1.2.3'
  const tag = options.tag ?? 'v1.2.3'
  const artifactsPath = join(root, `${platform}-paths.json`)
  const outputPath = join(root, `${platform}-output`)
  await writeFile(artifactsPath, JSON.stringify(paths))
  const manifest = await preparePlatformArtifacts({
    platform,
    version,
    tag,
    artifactsPath,
    outputPath
  })
  return { manifest, outputPath }
}

describe('preparePlatformArtifacts', () => {
  test.each([
    ['macos-aarch64', 'aarch64', 'darwin-aarch64'],
    ['macos-x64', 'x64', 'darwin-x86_64']
  ])('renames %s updater assets and preserves signature association', async (platform, arch, key) => {
    const root = await fixtureDir()
    const archive = await fixtureFile(root, 'bundle/macos/Termul Manager.app.tar.gz')
    const signature = await fixtureFile(
      root,
      'bundle/macos/Termul Manager.app.tar.gz.sig',
      `signature-${arch}\n`
    )
    const dmg = await fixtureFile(root, `bundle/dmg/Termul.Manager_1.2.3_${arch}.dmg`)

    const { manifest, outputPath } = await prepare(platform, [archive, signature, dmg], root)
    const updaterName = `Termul.Manager_${arch}.app.tar.gz`

    expect(manifest.assetNames).toContain(updaterName)
    expect(manifest.assetNames).toContain(`${updaterName}.sig`)
    expect(manifest.platforms[key]).toEqual({
      url: `https://github.com/gnoviawan/termul/releases/download/v1.2.3/${updaterName}`,
      signature: `signature-${arch}`
    })
    expect(await readFile(join(outputPath, 'assets', `${updaterName}.sig`), 'utf8')).toBe(
      `signature-${arch}\n`
    )
  })

  test('collects Windows MSI and NSIS paths', async () => {
    const root = await fixtureDir()
    const msi = await fixtureFile(root, 'bundle/msi/Termul.Manager_1.2.3_x64_en-US.msi')
    const msiSig = await fixtureFile(
      root,
      'bundle/msi/Termul.Manager_1.2.3_x64_en-US.msi.sig',
      'msi-signature'
    )
    const exe = await fixtureFile(root, 'bundle/nsis/Termul.Manager_1.2.3_x64-setup.exe')
    const exeSig = await fixtureFile(
      root,
      'bundle/nsis/Termul.Manager_1.2.3_x64-setup.exe.sig',
      'nsis-signature'
    )

    const { manifest } = await prepare('windows-x64', [msi, msiSig, exe, exeSig], root)
    expect(manifest.platforms['windows-x86_64'].url).toMatch(/_x64_en-US\.msi$/)
    expect(manifest.platforms['windows-x86_64-msi'].signature).toBe('msi-signature')
    expect(manifest.platforms['windows-x86_64-nsis'].url).toMatch(/_x64-setup\.exe$/)
  })

  test('collects Linux AppImage, deb, and rpm paths', async () => {
    const root = await fixtureDir()
    const paths = []
    for (const [bundle, name] of [
      ['appimage', 'Termul.Manager_1.2.3_amd64.AppImage'],
      ['deb', 'Termul.Manager_1.2.3_amd64.deb'],
      ['rpm', 'Termul.Manager-1.2.3-1.x86_64.rpm']
    ]) {
      paths.push(await fixtureFile(root, `bundle/${bundle}/${name}`))
      paths.push(await fixtureFile(root, `bundle/${bundle}/${name}.sig`, `${bundle}-signature`))
    }

    const { manifest } = await prepare('linux-x64', paths, root)
    expect(manifest.platforms['linux-x86_64'].url).toMatch(/\.AppImage$/)
    expect(manifest.platforms['linux-x86_64-appimage'].signature).toBe('appimage-signature')
    expect(manifest.platforms['linux-x86_64-deb'].url).toMatch(/\.deb$/)
    expect(manifest.platforms['linux-x86_64-rpm'].url).toMatch(/\.rpm$/)
  })

  test('rejects duplicate collected asset names even when paths are identical', async () => {
    const root = await fixtureDir()
    const msi = await fixtureFile(root, 'bundle/msi/Termul.Manager_1.2.3_x64_en-US.msi')
    const msiSig = await fixtureFile(
      root,
      'bundle/msi/Termul.Manager_1.2.3_x64_en-US.msi.sig',
      'signature'
    )

    await expect(prepare('windows-x64', [msi, msi, msiSig], root)).rejects.toThrow(
      'windows-x64 has duplicate release asset Termul.Manager_1.2.3_x64_en-US.msi'
    )
  })

  test('rejects multiple signatures for one updater bundle', async () => {
    const root = await fixtureDir()
    const first = await fixtureFile(root, 'one/msi/Termul.Manager_1.2.3_x64_en-US.msi.sig', 'one')
    const second = await fixtureFile(root, 'two/msi/Other_1.2.3_x64_en-US.msi.sig', 'two')
    const msi = await fixtureFile(root, 'one/msi/Termul.Manager_1.2.3_x64_en-US.msi')

    await expect(prepare('windows-x64', [msi, first, second], root)).rejects.toThrow(
      'windows-x64 must have exactly one msi updater signature'
    )
  })

  test('normalizes productName spaces to dots in Windows MSI and NSIS release asset names', async () => {
    const root = await fixtureDir()
    const msi = await fixtureFile(root, 'bundle/msi/Termul Manager_0.4.10_x64_en-US.msi')
    const msiSig = await fixtureFile(
      root,
      'bundle/msi/Termul Manager_0.4.10_x64_en-US.msi.sig',
      'msi-signature'
    )
    const exe = await fixtureFile(root, 'bundle/nsis/Termul Manager_0.4.10_x64-setup.exe')
    const exeSig = await fixtureFile(
      root,
      'bundle/nsis/Termul Manager_0.4.10_x64-setup.exe.sig',
      'nsis-signature'
    )

    const { manifest, outputPath } = await prepare(
      'windows-x64',
      [msi, msiSig, exe, exeSig],
      root,
      {
        version: '0.4.10',
        tag: 'v0.4.10'
      }
    )

    const msiName = 'Termul.Manager_0.4.10_x64_en-US.msi'
    const exeName = 'Termul.Manager_0.4.10_x64-setup.exe'
    expect(manifest.assetNames).toContain(msiName)
    expect(manifest.assetNames).toContain(`${msiName}.sig`)
    expect(manifest.assetNames).toContain(exeName)
    expect(manifest.assetNames).toContain(`${exeName}.sig`)
    expect(manifest.platforms['windows-x86_64-msi'].url).toBe(
      `https://github.com/gnoviawan/termul/releases/download/v0.4.10/${msiName}`
    )
    expect(manifest.platforms['windows-x86_64'].url).toBe(
      manifest.platforms['windows-x86_64-msi'].url
    )
    expect(manifest.platforms['windows-x86_64-msi'].url).not.toMatch(/%20/)
    expect(manifest.platforms['windows-x86_64-nsis'].url).toBe(
      `https://github.com/gnoviawan/termul/releases/download/v0.4.10/${exeName}`
    )
    expect(manifest.platforms['windows-x86_64-nsis'].url).not.toMatch(/%20/)
    expect(await readFile(join(outputPath, 'assets', msiName), 'utf8')).toBe('artifact')
    expect(await readFile(join(outputPath, 'assets', `${msiName}.sig`), 'utf8')).toBe(
      'msi-signature'
    )
    expect(await readFile(join(outputPath, 'assets', exeName), 'utf8')).toBe('artifact')
    expect(await readFile(join(outputPath, 'assets', `${exeName}.sig`), 'utf8')).toBe(
      'nsis-signature'
    )
  })

  test('normalizes only the productName space in Linux rpm release asset names', async () => {
    const root = await fixtureDir()
    const paths: string[] = []
    for (const [bundle, name] of [
      ['appimage', 'Termul Manager_0.4.10_amd64.AppImage'],
      ['deb', 'Termul Manager_0.4.10_amd64.deb'],
      ['rpm', 'Termul Manager-0.4.10-1.x86_64.rpm']
    ]) {
      paths.push(await fixtureFile(root, `bundle/${bundle}/${name}`))
      paths.push(await fixtureFile(root, `bundle/${bundle}/${name}.sig`, `${bundle}-signature`))
    }

    const { manifest, outputPath } = await prepare('linux-x64', paths, root, {
      version: '0.4.10',
      tag: 'v0.4.10'
    })

    const appimageName = 'Termul.Manager_0.4.10_amd64.AppImage'
    const debName = 'Termul.Manager_0.4.10_amd64.deb'
    const rpmName = 'Termul.Manager-0.4.10-1.x86_64.rpm'
    for (const name of [appimageName, debName, rpmName]) {
      expect(manifest.assetNames).toContain(name)
      expect(manifest.assetNames).toContain(`${name}.sig`)
    }
    expect(manifest.platforms['linux-x86_64-appimage'].url).toBe(
      `https://github.com/gnoviawan/termul/releases/download/v0.4.10/${appimageName}`
    )
    expect(manifest.platforms['linux-x86_64-appimage'].url).not.toMatch(/%20/)
    expect(manifest.platforms['linux-x86_64-deb'].url).toBe(
      `https://github.com/gnoviawan/termul/releases/download/v0.4.10/${debName}`
    )
    expect(manifest.platforms['linux-x86_64-deb'].url).not.toMatch(/%20/)
    expect(manifest.platforms['linux-x86_64-rpm'].url).toBe(
      `https://github.com/gnoviawan/termul/releases/download/v0.4.10/${rpmName}`
    )
    expect(manifest.platforms['linux-x86_64-rpm'].url).not.toMatch(/%20/)
    expect(await readFile(join(outputPath, 'assets', rpmName), 'utf8')).toBe('artifact')
    expect(await readFile(join(outputPath, 'assets', `${rpmName}.sig`), 'utf8')).toBe(
      'rpm-signature'
    )
  })
})
