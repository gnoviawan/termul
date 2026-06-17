import { generateManifest } from 'material-icon-theme'
import { describe, expect, it } from 'vitest'
import {
  getIconDefinitionFileName,
  type MaterialIconResolveInput,
  resolveMaterialIconKey
} from './material-icon-resolver'

const manifest = generateManifest()

function resolve(input: MaterialIconResolveInput): string {
  return resolveMaterialIconKey(manifest, input)
}

describe('resolveMaterialIconKey', () => {
  it('resolves package.json to the nodejs icon', () => {
    expect(
      resolve({
        name: 'package.json',
        extension: 'json',
        isDirectory: false,
        isExpanded: false,
        depth: 0
      })
    ).toBe('nodejs')
  })

  it('resolves TypeScript extensions', () => {
    expect(
      resolve({
        name: 'app.ts',
        extension: 'ts',
        isDirectory: false,
        isExpanded: false,
        depth: 1
      })
    ).toBe('typescript')
  })

  it('resolves README.md by file name', () => {
    expect(
      resolve({
        name: 'README.md',
        extension: 'md',
        isDirectory: false,
        isExpanded: false,
        depth: 0
      })
    ).toBe('readme')
  })

  it('resolves src folder with specific folder icon', () => {
    expect(
      resolve({
        name: 'src',
        extension: null,
        isDirectory: true,
        isExpanded: false,
        depth: 0
      })
    ).toBe('folder-src')
  })

  it('uses expanded folder icon for open directories', () => {
    expect(
      resolve({
        name: 'src',
        extension: null,
        isDirectory: true,
        isExpanded: true,
        depth: 0
      })
    ).toBe('folder-src-open')
  })

  it('resolves .github folder icon', () => {
    expect(
      resolve({
        name: '.github',
        extension: null,
        isDirectory: true,
        isExpanded: false,
        depth: 0
      })
    ).toBe('folder-github')
  })

  it('falls back to the default file icon for unknown extensions', () => {
    expect(
      resolve({
        name: 'notes.xyz',
        extension: 'xyz',
        isDirectory: false,
        isExpanded: false,
        depth: 2
      })
    ).toBe(manifest.file ?? 'file')
  })

  it('falls back to the default folder icon for unknown folders', () => {
    expect(
      resolve({
        name: 'zz-unknown-folder-xyz',
        extension: null,
        isDirectory: true,
        isExpanded: false,
        depth: 3
      })
    ).toBe(manifest.folder ?? 'folder')
  })

  it('maps icon keys to bundled svg file names', () => {
    const iconKey = resolve({
      name: 'index.tsx',
      extension: 'tsx',
      isDirectory: false,
      isExpanded: false,
      depth: 1
    })

    expect(getIconDefinitionFileName(manifest, iconKey)).toMatch(/\.svg$/)
  })
})
