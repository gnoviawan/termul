/**
 * Platform filtering for the web-only "Server" preferences page (gh-1105) —
 * the mirror of the Updates page's web filter (issue #843): the desktop app
 * has no `termul-server` to configure, so the category and its search
 * entries only exist on the web runtime.
 */

import { describe, expect, it, vi } from 'vitest'

const tauriRef = vi.hoisted(() => ({ current: false }))
vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: () => tauriRef.current }))

import { appPrefCategories, appPrefSearchIndex } from './categories'

describe('appPrefCategories Server page', () => {
  it('includes the Server page and hides Updates on the web runtime', () => {
    tauriRef.current = false
    const ids = appPrefCategories().map((category) => category.id)

    expect(ids).toContain('server')
    expect(ids).not.toContain('updates')
  })

  it('includes Updates and hides the Server page on the desktop runtime', () => {
    tauriRef.current = true
    const ids = appPrefCategories().map((category) => category.id)

    expect(ids).toContain('updates')
    expect(ids).not.toContain('server')
  })
})

describe('appPrefSearchIndex Server entries', () => {
  it('searches into the Server page on the web runtime', () => {
    tauriRef.current = false
    const entries = appPrefSearchIndex().filter((entry) => entry.categoryId === 'server')

    expect(entries).toHaveLength(1)
    expect(entries[0]?.label).toBe('Server')
  })

  it('has no Server entries on the desktop runtime', () => {
    tauriRef.current = true

    expect(appPrefSearchIndex().some((entry) => entry.categoryId === 'server')).toBe(false)
  })
})
