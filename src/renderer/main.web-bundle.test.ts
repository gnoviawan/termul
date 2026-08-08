/**
 * Story 1.5 — browser-safe bootstrap + web bundle assertions (AC1–AC3, AC6).
 *
 * Source checks run always. Dist-web fingerprint checks run when `dist-web/`
 * exists (after `bun run build:web`); otherwise they are skipped so unit CI
 * without a prior web build still passes. A dedicated build:web job / local
 * workflow should produce dist-web before relying on those assertions.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const mainTsxPath = path.join(repoRoot, 'src/renderer/main.tsx')
const tauriMainPath = path.join(repoRoot, 'src/renderer/tauri-main.tsx')
const viteWebConfigPath = path.join(repoRoot, 'vite.config.web.ts')
const viteTauriConfigPath = path.join(repoRoot, 'vite.config.tauri.ts')
const distWebAssetsDir = path.join(repoRoot, 'dist-web/assets')

/**
 * Fingerprints that indicate real `@tauri-apps` package code leaked into dist-web.
 *
 * Do NOT flag bare `__TAURI_INTERNALS__` — our `isTauriContext()` detector and a
 * few app-level guarded IPC calls mention that property by name. Real npm
 * packages embed import paths / plugin package ids; those must not appear.
 */
const REAL_TAURI_FINGERPRINTS = [
  '@tauri-apps/api',
  '@tauri-apps/plugin-',
  '@tauri-apps/plugin-updater',
  'from "@tauri-apps/',
  "from '@tauri-apps/"
] as const

describe('main.tsx browser-safe bootstrap (source)', () => {
  const source = readFileSync(mainTsxPath, 'utf8')

  it('imports isTauriContext from @/lib/tauri-runtime (no local detector)', () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bisTauriContext\b[^}]*\}\s*from\s*['"]@\/lib\/tauri-runtime['"]/
    )
    expect(source).not.toMatch(/function\s+isTauriContext\s*\(/)
  })

  it('does not statically import ./TauriApp', () => {
    expect(source).not.toMatch(/import\s+TauriApp\s+from\s+['"]\.\/TauriApp['"]/)
    expect(source).toMatch(/import\s*\(\s*['"]\.\/TauriApp['"]\s*\)/)
  })
})

describe('desktop path untouched (source)', () => {
  it('tauri-main.tsx still statically imports TauriApp', () => {
    const source = readFileSync(tauriMainPath, 'utf8')
    expect(source).toMatch(/import\s+TauriApp\s+from\s+['"]\.\/TauriApp['"]/)
  })

  it('vite.config.tauri.ts does not alias @tauri-apps to stubs', () => {
    const source = readFileSync(viteTauriConfigPath, 'utf8')
    expect(source).not.toMatch(/tauri-stubs/)
    expect(source).not.toMatch(/@tauri-apps\/api\/core['"]\s*:/)
  })

  it('vite.config.web.ts aliases @tauri-apps to stubs', () => {
    const source = readFileSync(viteWebConfigPath, 'utf8')
    expect(source).toMatch(/tauri-stubs/)
    expect(source).toMatch(/@tauri-apps\/api\/core/)
  })
})

describe('dist-web has no real @tauri-apps package code', () => {
  const hasDistWeb = existsSync(distWebAssetsDir)

  // Honest skip (not a soft-pass) when assets are missing — run `bun run build:web`
  // first, or rely on a CI job that builds dist-web before this suite.
  it.skipIf(!hasDistWeb)('emitted JS assets lack real Tauri package fingerprints', () => {
    const jsFiles = readdirSync(distWebAssetsDir).filter((f) => f.endsWith('.js'))
    expect(jsFiles.length).toBeGreaterThan(0)

    const hits: string[] = []
    for (const file of jsFiles) {
      const content = readFileSync(path.join(distWebAssetsDir, file), 'utf8')
      for (const fingerprint of REAL_TAURI_FINGERPRINTS) {
        if (content.includes(fingerprint)) {
          hits.push(`${file}: ${fingerprint}`)
        }
      }
    }

    expect(hits).toEqual([])
  })
})
