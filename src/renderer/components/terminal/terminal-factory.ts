/**
 * Terminal Factory
 *
 * Consolidation seam for xterm Terminal construction, addon loading, and
 * renderer selection. Created per Epic 3 Story 3.1 to reduce upgrade blast
 * radius for future xterm major-version changes.
 *
 * All four terminal surfaces (ConnectedTerminal, XTerminal, TauriTerminal,
 * use-xterm) should route their construction through this factory.
 */

import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ITerminalOptions } from '@xterm/xterm'
import { Terminal } from '@xterm/xterm'
import { getTerminalOptions } from './terminal-config'

/**
 * Renderer preference type for xterm 6.x.
 *
 * - "auto": Try WebGL first, fall back to DOM on context loss / failure
 * - "webgl": Force WebGL renderer
 * - "dom": Use the built-in DOM renderer (no WebGL attempt)
 *
 * Note: "canvas" was removed in xterm 6.0; persisted "canvas" values are
 * migrated to "dom" at settings load time.
 */
export type RendererPreference = 'auto' | 'webgl' | 'dom'

export interface TerminalFactory {
  createTerminal(options?: Partial<ITerminalOptions>): Terminal
  createFitAddon(): FitAddon
  createSearchAddon(): SearchAddon
  createWebLinksAddon(): WebLinksAddon
  createWebglAddon(): WebglAddon
  shouldUseWebglRenderer(preference: RendererPreference, isMobileWebShell?: boolean): boolean
}

/**
 * Create a Terminal instance with platform-aware options merged over defaults.
 *
 * @param overrides - Optional partial ITerminalOptions to merge on top of the
 *                    default options from terminal-config.
 * @param platform  - Platform string (defaults to navigator.platform). Pass an
 *                    explicit value in tests to avoid navigator dependency.
 */
function createTerminal(
  overrides?: Partial<ITerminalOptions>,
  platform: string = typeof navigator !== 'undefined' ? navigator.platform : ''
): Terminal {
  const baseOptions = getTerminalOptions(platform)
  const options: ITerminalOptions = overrides ? { ...baseOptions, ...overrides } : baseOptions
  return new Terminal(options)
}

function createFitAddon(): FitAddon {
  return new FitAddon()
}

function createSearchAddon(): SearchAddon {
  return new SearchAddon()
}

function createWebLinksAddon(): WebLinksAddon {
  return new WebLinksAddon()
}

/**
 * Create a WebglAddon instance.
 *
 * The returned addon can be wired with context-loss recovery at the consumer
 * site (ConnectedTerminal owns the full recovery loop). This factory just
 * creates the instance.
 */
function createWebglAddon(): WebglAddon {
  return new WebglAddon()
}

/**
 * Decide whether to attempt the WebGL renderer based on user preference.
 *
 * - "auto" and "webgl" → true (try WebGL)
 * - "dom" → false (skip WebGL entirely, rely on built-in DOM renderer)
 *
 * Mobile web shell stopgap (story 2 / QA blank-terminal at DPR >= 3): when
 * the mobile web shell is active, "auto" (the shipped default) resolves to
 * the DOM renderer — WebGL paints zero pixels on high-DPR phones. Explicit
 * "webgl" or "dom" is always honored on every surface; desktop resolves
 * "auto" → WebGL exactly as before. Story 3's WebGL root fix supersedes this.
 */
export function shouldUseWebglRenderer(
  preference: RendererPreference,
  isMobileWebShell = false
): boolean {
  if (preference === 'dom') return false
  if (preference === 'webgl') return true
  // 'auto' — the shipped default. WebGL everywhere except the mobile web
  // shell, where the DOM renderer is the stopgap until story 3 lands.
  return !isMobileWebShell
}

/** Singleton factory instance. */
export const terminalFactory: TerminalFactory = {
  createTerminal,
  createFitAddon,
  createSearchAddon,
  createWebLinksAddon,
  createWebglAddon,
  shouldUseWebglRenderer
}
