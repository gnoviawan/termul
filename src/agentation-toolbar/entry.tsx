/**
 * Agentation toolbar entry point — shadow DOM wrapper.
 *
 * Mounts the agentation React toolbar inside a shadow DOM root to isolate
 * it from the host page's CSS. The endpoint is read from a global variable
 * injected by Rust's BrowserTabManager (window.__TERMUL_AGENTATION_ENDPOINT__).
 *
 * Shadow DOM isolation:
 * - `:host` reset: box-sizing: border-box, display: block !important
 * - `px` not `rem` (prevent host page root font-size from scaling toolbar)
 * - All toolbar CSS scoped inside the shadow root
 */

import { Agentation } from 'agentation'
// React + ReactDOM for the toolbar (bundled into the IIFE)
import React from 'react'
import { createRoot } from 'react-dom/client'

// Shadow DOM isolation styles — pinned to prevent host page leakage
const SHADOW_STYLES = `
:host {
  all: initial;
  display: block !important;
  position: fixed !important;
  z-index: 2147483647 !important;
  bottom: 0 !important;
  left: 0 !important;
  right: 0 !important;
  pointer-events: none !important;
}

:host * {
  box-sizing: border-box !important;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
  font-size: 14px !important;
  line-height: 1.5 !important;
  letter-spacing: normal !important;
  word-spacing: normal !important;
}

:host(.agentation-toolbar-active) {
  pointer-events: auto !important;
}
`

function mountToolbar() {
  // Read endpoint from global injected by Rust BrowserTabManager
  const endpoint = (window as any).__TERMUL_AGENTATION_ENDPOINT__ as string | undefined
  const sessionId = (window as any).__TERMUL_AGENTATION_SESSION_ID__ as string | undefined

  if (!endpoint) {
    console.warn('[Agentation] No endpoint configured — toolbar will not sync annotations')
  }

  // Check if toolbar already mounted
  const existingHost = document.getElementById('termul-agentation-host')
  if (existingHost?.shadowRoot) {
    return
  }

  // Create shadow DOM host element
  const host = document.createElement('div')
  host.id = 'termul-agentation-host'
  host.style.cssText =
    'all: initial; position: fixed; z-index: 2147483647; bottom: 0; left: 0; right: 0; pointer-events: none;'
  document.body.appendChild(host)

  // Attach shadow DOM
  const shadow = host.attachShadow({ mode: 'open' })

  // Inject isolation styles
  const style = document.createElement('style')
  style.textContent = SHADOW_STYLES
  shadow.appendChild(style)

  // Create mount point for React — pointer-events: auto immediately
  // so the toolbar is interactive before onAnnotationAdd fires
  const mountPoint = document.createElement('div')
  mountPoint.style.cssText = 'all: initial; pointer-events: auto;'
  shadow.appendChild(mountPoint)

  // Mount the agentation toolbar
  const root = createRoot(mountPoint)
  root.render(
    React.createElement(Agentation, {
      endpoint: endpoint || 'http://127.0.0.1:0',
      sessionId: sessionId,
      onAnnotationAdd: () => {
        host.classList.add('agentation-toolbar-active')
      }
    })
  )

  ;(window as any).__TERMUL_AGENTATION_ROOT__ = root
  ;(window as any).__TERMUL_AGENTATION_HOST__ = host

  console.log('[Agentation] Toolbar mounted', { endpoint, sessionId })
}

/**
 * React page detection — if the page is a React app, the toolbar may cause
 * "Invalid hook call" if React versions conflict. In that case, we should
 * fall back to termul's existing vanilla-JS overlay.
 */
function isReactPage(): boolean {
  // Check for React DevTools global
  if ((window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__) return true
  // Check for React root container
  const root = document.getElementById('root')
  if (root && (root as any)._reactRootContainer) return true
  // Check for React 18+ root
  if (root && Object.keys(root).some((k) => k.startsWith('__reactFiber'))) return true
  // Check for Next.js
  if ((window as any).__NEXT_DATA__) return true
  // Check for Gatsby
  if ((window as any).___gatsby) return true
  return false
}

/**
 * Main init — deferred to DOMContentLoaded if document is still loading.
 * Initialization scripts run before the DOM is parsed, so document.body
 * is null at that point. We MUST wait for the DOM.
 */
function start() {
  // When injected via eval (button click or delayed injection),
  // __TERMUL_ANNOTATION_MODE__ may not be set. Mount unconditionally —
  // the user clicked the button, so they want the toolbar.

  // React page detection removed — the toolbar uses its own bundled React
  // instance in shadow DOM, so version collision is not a concern.
  // Mount on all pages including React apps.

  mountToolbar()
}

function init() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
}

// Cleanup on page unload
function cleanup() {
  const root = (window as any).__TERMUL_AGENTATION_ROOT__
  const host = (window as any).__TERMUL_AGENTATION_HOST__
  if (root) {
    root.unmount()
  }
  if (host?.parentNode) {
    host.parentNode.removeChild(host)
  }
}

// Auto-init
init()

// Cleanup on page unload
window.addEventListener('beforeunload', cleanup)

// Export for manual control
;(window as any).TermulAgentation = {
  mount: mountToolbar,
  unmount: cleanup,
  isReactPage
}
