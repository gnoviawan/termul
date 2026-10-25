/**
 * The GPUIX client's browser host (`src/renderer/lib/browser-host.ts`): browser panes are wry
 * webviews in a `termul-webview-host` process, embedded as X11 children of this window.
 *
 * The helper starts with the first tab and is restarted by the next request if it dies (its tabs
 * are gone then; the pane shows an empty webview until it is reopened). Keyboard pairing works
 * with the helper: a press in a webview gives it the keyboard and blurs the GPUIX element that
 * had focus, so the next GPUIX focus change is visible here and hands the keyboard back.
 */

import type { BrowserHost } from '@/lib/browser-host'
import type {
  BrowserBounds,
  BrowserEventSubscription,
  BrowserTabLoadedPayload,
  BrowserTabNavigatedPayload,
  BrowserTabTitleChangedPayload,
  IpcResult
} from '@/lib/browser-types'
import { log } from '../log'
import type { CanvasWebviewHost } from './canvas-relay'
import { type AckResult, HostProcess } from './host-process'
import type { HostEvent, HostRequest } from './protocol'

export interface GpuixBrowserHostOptions {
  binary: string
  /** This process; the helper finds the GPUIX window by its `_NET_WM_PID`. */
  parentPid: number
  /** Cookies, storage and cache of every tab (one profile, as in the desktop app). */
  dataDir?: string
  /** GPUIX's focused element id, polled while a webview holds the keyboard. */
  focusedElement(): number | null
  /** Clear GPUIX focus when a webview takes the keyboard, as a page blurs for an iframe. */
  blurApp(): void
  /** How often to look for a GPUIX focus change while a webview holds the keyboard. */
  focusPollMs?: number
}

export interface GpuixBrowserHost extends BrowserHost, CanvasWebviewHost {
  /** Which tab holds the keyboard, `null` for the app window (tests and diagnostics). */
  keyboardOwner(): string | null
  helperPid(): number | undefined
  /** Close every webview and stop the helper. */
  shutdown(): void
  /** Synchronous kill for `process.on('exit')`. */
  kill(): void
}

const SOURCE = 'browser'

function toIpc(result: AckResult): IpcResult<void> {
  return result.ok
    ? { success: true, data: undefined }
    : { success: false, error: result.error, code: 'WEBVIEW_HOST' }
}

function subscribers<T>() {
  const set = new Set<(payload: T) => void>()
  return {
    add(callback: (payload: T) => void): BrowserEventSubscription {
      set.add(callback)
      return { unlisten: () => set.delete(callback) }
    },
    emit(payload: T) {
      for (const callback of set) callback(payload)
    }
  }
}

export function createGpuixBrowserHost(options: GpuixBrowserHostOptions): GpuixBrowserHost {
  const navigated = subscribers<BrowserTabNavigatedPayload>()
  const loaded = subscribers<BrowserTabLoadedPayload>()
  const titles = subscribers<BrowserTabTitleChangedPayload>()
  const canvasListeners = new Map<string, Set<(data: string) => void>>()
  let helper: HostProcess | null = null
  let keyboard: string | null = null
  let focusPoll: ReturnType<typeof setInterval> | null = null

  const stopFocusPoll = () => {
    if (focusPoll) clearInterval(focusPoll)
    focusPoll = null
  }

  const onEvent = (event: HostEvent) => {
    switch (event.ev) {
      case 'ready':
        log.info(
          SOURCE,
          `webview host ${event.pid} attached to window 0x${event.parent.toString(16)}`
        )
        return
      case 'navigated':
        navigated.emit({ browserTabId: event.id, url: event.url })
        return
      case 'loaded':
        loaded.emit({ browserTabId: event.id })
        return
      case 'title':
        titles.emit({ browserTabId: event.id, title: event.title })
        return
      case 'console': {
        const line = `[${event.id}] ${event.level}: ${event.text}`
        if (event.level === 'error') log.error('browser-console', line)
        else if (event.level === 'warn') log.warn('browser-console', line)
        else log.info('browser-console', line)
        return
      }
      case 'canvasMessage':
        for (const callback of canvasListeners.get(event.id) ?? []) callback(event.data)
        return
      case 'keyboard':
        keyboard = event.owner
        log.info(SOURCE, `keyboard -> ${keyboard === null ? 'app' : `tab ${keyboard}`}`)
        stopFocusPoll()
        if (keyboard === null) return
        options.blurApp()
        focusPoll = setInterval(() => {
          if (options.focusedElement() !== null) void request({ op: 'blur' })
        }, options.focusPollMs ?? 50)
        return
      case 'fatal':
        log.error(SOURCE, `webview host failed: ${event.error}`)
        return
      case 'invalid':
        log.error(SOURCE, `webview host rejected ${event.line.slice(0, 200)}: ${event.error}`)
        return
    }
  }

  const ensure = (): HostProcess => {
    if (helper?.alive) return helper
    const started = new HostProcess({
      binary: options.binary,
      args: [
        '--parent-pid',
        String(options.parentPid),
        ...(options.dataDir ? ['--data-dir', options.dataDir] : [])
      ],
      onEvent,
      onStderr: (line) => log.info('webview-host', line),
      onExit: (detail) => {
        log.warn(SOURCE, `webview host ${started.pid ?? '?'} ${detail}`)
        if (helper === started) helper = null
        keyboard = null
        stopFocusPoll()
      }
    })
    log.info(SOURCE, `started webview host ${started.pid ?? '?'} (${options.binary})`)
    helper = started
    return started
  }

  const request = (req: HostRequest): Promise<AckResult> => ensure().request(req)
  /** Commands for a tab when no helper runs: nothing to act on, and nothing to start for it. */
  const tabRequest = async (req: HostRequest & { id: string }): Promise<IpcResult<void>> => {
    if (!helper?.alive)
      return { success: false, error: `no webview for tab ${req.id}`, code: 'WEBVIEW_HOST' }
    const result = await helper.request(req)
    if (!result.ok) log.warn(SOURCE, `${req.op} ${req.id} failed: ${result.error}`)
    return toIpc(result)
  }

  return {
    async create(tabId, url, bounds: BrowserBounds) {
      const result = await request({ op: 'create', id: tabId, url, bounds })
      if (!result.ok) {
        log.error(SOURCE, `create ${tabId} failed: ${result.error}`)
        return { success: false, error: result.error, code: 'WEBVIEW_HOST' }
      }
      log.info(SOURCE, `created tab ${tabId}`)
      return { success: true, data: { id: tabId, url, title: '', agentControlled: false } }
    },
    navigate: (tabId, url) => tabRequest({ op: 'navigate', id: tabId, url }),
    resize: (tabId, bounds) => tabRequest({ op: 'bounds', id: tabId, bounds }),
    show: (tabId) => tabRequest({ op: 'show', id: tabId }),
    hide: (tabId) => tabRequest({ op: 'hide', id: tabId }),
    async destroy(tabId) {
      const result = await tabRequest({ op: 'destroy', id: tabId })
      if (result.success) log.info(SOURCE, `destroyed tab ${tabId}`)
      return result
    },
    goBack: (tabId) => tabRequest({ op: 'back', id: tabId }),
    goForward: (tabId) => tabRequest({ op: 'forward', id: tabId }),
    reload: (tabId) => tabRequest({ op: 'reload', id: tabId }),
    openDevtools: (tabId) => tabRequest({ op: 'devtools', id: tabId }),
    async createCanvas(tabId, url, bounds) {
      const result = await request({ op: 'createCanvas', id: tabId, url, bounds })
      if (!result.ok) {
        log.error(SOURCE, `create canvas ${tabId} failed: ${result.error}`)
        return { success: false, error: result.error, code: 'WEBVIEW_HOST' }
      }
      log.info(SOURCE, `created canvas ${tabId}`)
      return { success: true, data: undefined }
    },
    postToCanvas: (tabId, data) => tabRequest({ op: 'post', id: tabId, data }),
    onCanvasMessage(tabId, callback) {
      const set = canvasListeners.get(tabId) ?? new Set()
      canvasListeners.set(tabId, set.add(callback))
      return {
        unlisten: () => {
          set.delete(callback)
          if (set.size === 0) canvasListeners.delete(tabId)
        }
      }
    },
    releaseKeyboard(tabId) {
      if (keyboard === tabId) void request({ op: 'blur' })
    },
    injectAgentation: async () => ({
      success: false,
      error: 'Agentation injection requires Tauri desktop',
      code: 'NOT_TAURI'
    }),
    onNavigated: navigated.add,
    onLoaded: loaded.add,
    onTitleChanged: titles.add,
    keyboardOwner: () => keyboard,
    helperPid: () => (helper?.alive ? helper.pid : undefined),
    shutdown() {
      stopFocusPoll()
      helper?.quit()
    },
    kill() {
      helper?.kill()
    }
  }
}
