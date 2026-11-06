import type { BrowserShareView } from '@/lib/browser-share-api'

/** A host share view as `browser_share_create` would return it. */
export function browserShareView(overrides: Partial<BrowserShareView> = {}): BrowserShareView {
  const shareId = overrides.shareId ?? 'host-share-1'
  return {
    shareId,
    sessionId: 'sess-1',
    tabId: 'tab-1',
    origin: 'https://app.example.com',
    scopes: ['content', 'console_errors'],
    expiresAtMs: Date.now() + 10 * 60_000,
    status: 'active',
    reference: { uri: `termul-browser-share://${shareId}`, name: 'Browser page' },
    ...overrides
  }
}
