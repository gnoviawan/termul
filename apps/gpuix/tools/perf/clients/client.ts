import type { PageMetrics } from '../../../../../tools/perf/types.ts'

export type ClientKind = 'chromium' | 'gpuix' | 'tauri'
export type GlMode = 'lavapipe' | 'swiftshader' | 'cpu' | 'gpu'

export interface ClientLaunchOptions {
  /** Origin the client loads or connects to (the byte proxy, not the server). */
  url: string
  display: string
  width: number
  height: number
  /** Built web client served in place of the server's compiled-in assets. */
  distWeb: string
  /** Rasterizer. lavapipe is the Vulkan driver the GPUIX lane uses on Linux; `gpu` is the machine's GPU (Windows). */
  gl: GlMode
  /** Skip the in-page observers, whose rAF loop keeps an idle page drawing. */
  noPageMetrics?: boolean
}

export interface ChatStartPart {
  typeMs: number
  openMs: number
}

/** What every client lane must expose to the scenarios. */
export interface ClientHandle {
  kind: ClientKind
  /** Root of the client's process tree; the proc sampler walks from here. */
  rootPid: number
  /** Wall ms from launch() call until the process tree existed. */
  launchedMs: number
  /**
   * Ms the harness spent before the client process existed that is not the
   * client's startup (the desktop lane's PowerShell launch); startup times omit it.
   */
  launchOverheadMs?: number
  version: string
  /** Free-form facts about the rendering backend, recorded with the run. */
  backend: string
  close(): Promise<void>
}

/**
 * User-level actions a scenario drives. A GPUIX lane implements the same
 * methods through @gpuix/react/automation; nothing here reaches into the
 * web client's internals.
 */
export interface ClientDriver {
  handle: ClientHandle
  /** Resolves once the sidebar lists the seeded project. */
  waitForProjectList(): Promise<void>
  /** Resolves once the empty-pane agent launcher accepts input. */
  waitForLauncher(): Promise<void>
  startChat(prompt: string): Promise<void>
  chatCount(): Promise<number>
  switchToChat(index: number): Promise<void>
  /**
   * Drags the sidebar card of the chat titled `title` onto the right edge of
   * the left-most pane, splitting the chat into a pane of its own. The card
   * rather than the tab: a narrow pane's tab strip clips its later tabs.
   */
  splitChatRight(title: string): Promise<void>
  /** Chats on screen at once, one per pane. */
  visibleChatCount(): Promise<number>
  /** Opens one terminal tab with the default shell and focuses it. */
  openTerminal(): Promise<void>
  /** Types a command into the focused terminal and presses Enter. */
  runInTerminal(command: string): Promise<void>
  /** Resolves when `marker` is visible in the focused terminal's screen. */
  waitForTerminalText(marker: string, timeoutMs: number): Promise<void>
  /**
   * Per chat start: ms spent typing the prompt, and ms from the Start click
   * until the chat tab existed and the launcher closed.
   */
  chatStartParts(): ChatStartPart[]
  /** The client's own crash report, when it replaced its UI with one; else null. */
  crashed(): Promise<string | null>
  /** In-page metrics, when the client is a web page; null otherwise. */
  beginPhase(name: string): Promise<void>
  endPhase(name: string): Promise<PageMetrics | null>
}
