import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Parse `public/manifest.webmanifest` and verify the install contract:
 * required PWA fields are present and every referenced icon exists on disk as
 * a real PNG. Catches broken icon paths or dropped fields before a release.
 */

const PUBLIC_DIR = resolve(__dirname, '../../../public')
const MANIFEST_PATH = join(PUBLIC_DIR, 'manifest.webmanifest')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

type ManifestIcon = { src: string; sizes: string; type: string; purpose?: string }
type Manifest = {
  id?: string
  lang?: string
  name?: string
  short_name?: string
  start_url?: string
  scope?: string
  display?: string
  theme_color?: string
  background_color?: string
  categories?: string[]
  icons?: ManifestIcon[]
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest

describe('public/manifest.webmanifest', () => {
  it('exists and parses as JSON', () => {
    expect(manifest).toBeTypeOf('object')
  })

  it('declares the required PWA fields', () => {
    expect(manifest.id).toBe('/')
    expect(manifest.lang).toBe('en')
    expect(manifest.name).toBe('Termul')
    expect(manifest.short_name).toBe('Termul')
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
    expect(manifest.theme_color).toBe('#1E1E1E')
    expect(manifest.background_color).toBe('#0F172A')
    expect(manifest.categories).toEqual(expect.arrayContaining(['utilities', 'productivity']))
  })

  it('declares installable icons (192 + 512 any-purpose, 512 maskable)', () => {
    const icons = manifest.icons ?? []
    const has = (sizes: string, purpose: string) =>
      icons.some((i) => i.sizes === sizes && (i.purpose ?? 'any') === purpose)
    // Chrome install criteria need at least 192 + 512.
    expect(has('192x192', 'any')).toBe(true)
    expect(has('512x512', 'any')).toBe(true)
    // Maskable entry for Android adaptive icons.
    expect(has('512x512', 'maskable')).toBe(true)
  })

  it('every referenced icon exists on disk and is a real PNG', () => {
    const icons = manifest.icons ?? []
    expect(icons.length).toBeGreaterThan(0)
    for (const icon of icons) {
      expect(icon.src.startsWith('/'), `icon src ${icon.src} should be root-absolute`).toBe(true)
      const onDisk = join(PUBLIC_DIR, icon.src)
      expect(existsSync(onDisk), `missing icon file: ${icon.src}`).toBe(true)
      const bytes = readFileSync(onDisk)
      expect(
        bytes.subarray(0, 8).equals(PNG_SIGNATURE),
        `${icon.src} is not a PNG (bad signature)`
      ).toBe(true)
    }
  })

  it('each PNG IHDR size matches the manifest-declared sizes entry', () => {
    // PNG width/height are big-endian u32 at byte offset 16 (8-byte signature
    // + 4-byte length + 4-byte 'IHDR'). A resized/regenerated icon that no
    // longer matches `sizes` would pass install criteria on some browsers and
    // fail on others — pin the contract here.
    for (const icon of manifest.icons ?? []) {
      const bytes = readFileSync(join(PUBLIC_DIR, icon.src))
      const [width, height] = icon.sizes.split('x').map(Number)
      expect(bytes.readUInt32BE(16), `${icon.src} IHDR width`).toBe(width)
      expect(bytes.readUInt32BE(20), `${icon.src} IHDR height`).toBe(height)
    }
    // The apple-touch-icon is referenced by index.html (not the manifest) —
    // check its declared 180x180 too.
    const apple = readFileSync(join(PUBLIC_DIR, 'icons/apple-touch-icon.png'))
    expect(apple.readUInt32BE(16)).toBe(180)
    expect(apple.readUInt32BE(20)).toBe(180)
  })

  it('the favicon linked by index.html exists', () => {
    expect(existsSync(join(PUBLIC_DIR, 'favicon.ico'))).toBe(true)
  })

  it('the apple-touch-icon referenced by index.html also exists', () => {
    // Not in the manifest (iOS ignores it) — index.html links it directly.
    expect(existsSync(join(PUBLIC_DIR, 'icons/apple-touch-icon.png'))).toBe(true)
  })

  it('the service worker the web client registers exists', () => {
    expect(existsSync(join(PUBLIC_DIR, 'sw.js'))).toBe(true)
  })
})
