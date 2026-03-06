/**
 * APP BOOTSTRAP ENTRY POINT
 * =========================
 *
 * This is the generic renderer entry point for Termul Manager.
 * The desktop runtime is Tauri-first, while this file remains useful for
 * browser-based development, preview, and test harnesses.
 *
 * Bootstrap Strategy:
 * ------------------
 * 1. Tauri Runtime (Primary): Uses TauriApp component with Tauri-specific hooks
 *    - Entry via: tauri-index.html -> tauri-main.tsx -> TauriApp
 *    - Includes: Window state management, Tauri IPC APIs
 *
 * 2. Browser/Development Runtime: Uses App component with browser-compatible hooks
 *    - Entry via: index.html -> main.tsx -> App
 *    - Includes: Alt-key prevention and non-native fallbacks needed for local preview
 *
 * Context Detection:
 * -----------------
 * The `isTauriContext()` guard checks for window.__TAURI_INTERNALS__ which
 * Tauri injects before any page script runs. This is the definitive signal
 * that we're in a Tauri WebView context.
 *
 * NO SILENT FALLBACKS:
 * -------------------
 * - Tauri APIs are protected by explicit isTauriContext() guards
 * - Each runtime path is deliberately chosen, not accidentally discovered
 *
 * Current State:
 * --------------
 * - TauriApp is the canonical desktop implementation
 * - App is the browser/dev fallback used outside the Tauri runtime
 * - New desktop-native behavior should be added to TauriApp first
 */

import { createRoot } from 'react-dom/client'
import TauriApp from './TauriApp'
import App from './App'
import './index.css'

/**
 * Detect if running in Tauri context
 * Tauri injects __TAURI_INTERNALS__ before any page script runs
 */
function isTauriContext(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== 'undefined'
  )
}

/**
 * Bootstrap the appropriate app component based on runtime context
 *
 * - Tauri context: Use TauriApp with window state management
 * - Browser/dev context: Use App with browser-safe hooks
 */
const AppComponent = isTauriContext() ? TauriApp : App

createRoot(document.getElementById('root')!).render(<AppComponent />)
