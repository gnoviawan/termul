/**
 * APP BOOTSTRAP ENTRY POINT
 * =========================
 *
 * This is the primary entry point for Termul Manager. Following the Tauri-first
 * migration strategy, this entry point serves BOTH Tauri and Electron contexts.
 *
 * Bootstrap Strategy:
 * ------------------
 * 1. Tauri Runtime (Primary): Uses TauriApp component with Tauri-specific hooks
 *    - Entry via: tauri-index.html -> tauri-main.tsx -> TauriApp
 *    - Includes: Window state management, Tauri IPC APIs
 *
 * 2. Electron Runtime (Legacy): Uses App component with browser-compatible hooks
 *    - Entry via: index.html -> main.tsx -> App
 *    - Includes: Alt-key prevention, Electron IPC APIs
 *
 * 3. Development/Browser: Uses App component for hot reload
 *    - Entry via: vite dev server -> main.tsx -> App
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
 * - Electron APIs are wrapped in similar guards for that context
 * - Each runtime path is deliberately chosen, not accidentally discovered
 *
 * Migration Path:
 * --------------
 * As we complete the Tauri-first migration:
 * - TauriApp becomes the canonical implementation
 * - App becomes the legacy Electron/development fallback
 * - All new features should be added to TauriApp first
 * - Electron compatibility is maintained via facade pattern in @/lib/api
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
 * - Browser/Electron: Use App with Alt-key prevention and browser hooks
 */
const AppComponent = isTauriContext() ? TauriApp : App

createRoot(document.getElementById('root')!).render(<AppComponent />)
