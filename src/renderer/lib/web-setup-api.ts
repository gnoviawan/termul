/**
 * Server setup / reconfigure facade — web client only (gh-1105).
 *
 * Two route families, per the settled wire contract in
 * `src/shared/types/server-setup.types.ts`:
 *
 * - `/setup/*` — served only by the minimal setup-mode router
 *   `termul-server` boots when no `server-config.json` exists
 *   (`src-tauri/src/web/setup.rs`). Every call is gated by the one-time
 *   CSPRNG setup token the server prints to stdout/journal as part of the
 *   `http://host:port/?setup=<token>` boot URL. The renderer carries it from
 *   the `?setup=` query param (SETUP_TOKEN_PARAM) into an
 *   `Authorization: Bearer` header on `/setup/*` ONLY — the web auth token
 *   (`authHeader()`) is never sent there and the setup token is never sent
 *   anywhere else.
 * - `/server/config` — the normal-mode reconfigure routes
 *   (`web/router.rs`, standalone `termul-server` only), authenticated like
 *   every other gated route through `getJson`/`postJson` + `authHeader()`.
 *
 * The setup token is parsed ONCE from `location.search`, kept in module
 * memory and mirrored to `sessionStorage` so a reload during the
 * restart-wait (the ~400ms window where the server re-execs) still has it —
 * the param is stripped from the address bar on first sight, exactly like
 * the `#token=` fragment flow in `web-auth-token.ts`. Never `localStorage`
 * (the token dies with the setup-mode process and must not outlive the
 * tab), never logged.
 *
 * All `/setup/*` and `/server/config` replies carry the `IpcBody<T>`
 * envelope — `parseBody` preserves a structured failure on any HTTP status
 * (a missing/wrong setup token answers 401 `UNAUTHORIZED`); transport and
 * parse failures map to `IpcResult { success:false, code:'NETWORK_ERROR' }`
 * so the renderer never sees a thrown exception from the network layer.
 *
 * Desktop (`isTauriContext()`) has no setup surface at all — the shared-live
 * host never serves these routes — so every method answers an explicit
 * `DESKTOP_UNSUPPORTED` failure instead of hitting a phantom origin
 * (`serverBase()` is '' under Tauri).
 */

import type { IpcResult } from '@shared/types/ipc.types'
import {
  SETUP_API_PATHS,
  SETUP_TOKEN_PARAM,
  type ServerConfigResponse,
  type ServerSetupAnswers,
  type SetupApplyReply,
  type SetupStatusResponse,
  type SetupValidateResponse
} from '@shared/types/server-setup.types'
import { getJson, networkError, parseBody, postJson, serverBase } from './ipc/http'
import { logFrontendError } from './log-api'
import { isTauriContext } from './tauri-runtime'

const LOG_SOURCE = 'web-setup-api'

/**
 * sessionStorage key for the one-time setup token. Deliberately NOT
 * localStorage: the token is per-setup-boot and worthless once the process
 * re-execs — it must not survive the tab.
 */
const SETUP_TOKEN_SESSION_KEY = 'termul.serverSetupToken'

/** The resolved setup token. `undefined` = not yet resolved; `null` = none. */
let setupToken: string | null | undefined

/** One-shot warn latch: a `/setup/*` call without a token logs once. */
let warnedMissingToken = false

function safeSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    // Access can throw (disabled storage / opaque origins) — treat as absent.
    return null
  }
}

/**
 * Resolve the one-time setup token. Precedence mirrors `getWebAuthToken`:
 * the `?setup=` query param is authoritative on first sight (stripped from
 * the visible URL, persisted to sessionStorage, cached in module memory),
 * then the module cache, then the sessionStorage copy — the last is what a
 * reload during the restart-wait window falls back to. `null` when none
 * exists (e.g. opening the client without the printed setup URL).
 *
 * Never logs the token — only the fact that one was captured.
 */
export function getSetupToken(): string | null {
  if (setupToken !== undefined) return setupToken
  if (typeof window === 'undefined' || !window.location) {
    setupToken = null
    return setupToken
  }
  const fromUrl = new URLSearchParams(window.location.search ?? '').get(SETUP_TOKEN_PARAM)
  if (fromUrl) {
    // Strip the param from the address bar FIRST (best-effort — replaceState
    // can throw on opaque origins): the token leaves the visible URL,
    // history and bookmarks immediately, exactly like `#token=`. The hash
    // router's location.hash is preserved verbatim.
    try {
      const params = new URLSearchParams(window.location.search)
      params.delete(SETUP_TOKEN_PARAM)
      const rest = params.toString()
      const url = `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash ?? ''}`
      window.history.replaceState(window.history.state, '', url)
    } catch {
      // Opaque origin — ignore; the token still applies via the caches below.
    }
    try {
      safeSessionStorage()?.setItem(SETUP_TOKEN_SESSION_KEY, fromUrl)
    } catch {
      // Quota/SecurityError is non-fatal: the module cache covers the session.
    }
    setupToken = fromUrl
    void logFrontendError({
      level: 'info',
      source: LOG_SOURCE,
      message:
        'setup token captured from the boot URL; kept in sessionStorage for restart-wait reloads'
    })
    return setupToken
  }
  try {
    setupToken = safeSessionStorage()?.getItem(SETUP_TOKEN_SESSION_KEY) || null
  } catch {
    setupToken = null
  }
  return setupToken
}

/**
 * The `Authorization` header for `/setup/*` calls: `Bearer <setup token>`
 * or nothing. A call without a token is answered 401 by the token
 * middleware — logged once per session (durable boundary log, never the
 * token itself) because the only legitimate token source is the URL the
 * server printed at setup-mode boot.
 */
function setupAuthHeader(): Record<string, string> | undefined {
  const token = getSetupToken()
  if (!token && !warnedMissingToken) {
    warnedMissingToken = true
    void logFrontendError({
      level: 'warn',
      source: LOG_SOURCE,
      message:
        'a /setup/* request was sent without a setup token; the server refuses it (401) — the token only arrives via the printed ?setup= boot URL'
    })
  }
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

/**
 * GET a `/setup/*` route with the setup-token bearer and map the reply to
 * `IpcResult<T>` — identical transport semantics to `getJson` (body parsed
 * first so a structured failure keeps its code on any status, NETWORK_ERROR
 * on transport/parse failure), but carrying the setup token instead of the
 * web auth token.
 */
async function setupGetJson<T>(path: string): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'GET',
      headers: setupAuthHeader()
    })
    return await parseBody<T>(res)
  } catch (err) {
    return networkError(err instanceof Error ? err.message : String(err))
  }
}

/** POST a `/setup/*` route — same contract as {@link setupGetJson}. */
async function setupPostJson<T>(path: string, body: unknown): Promise<IpcResult<T>> {
  try {
    const res = await fetch(`${serverBase()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...setupAuthHeader() },
      body: JSON.stringify(body)
    })
    return await parseBody<T>(res)
  } catch (err) {
    return networkError(err instanceof Error ? err.message : String(err))
  }
}

/**
 * The unsupported-path code for desktop callers — the mirror of the
 * `WEB_UNSUPPORTED` convention (`tauri-opener-api.ts`): a typed refusal
 * instead of a thrown Tauri stub (AGENTS.md).
 */
export const DESKTOP_UNSUPPORTED_CODE = 'DESKTOP_UNSUPPORTED'

function desktopUnsupported<T>(operation: string): IpcResult<T> {
  return {
    success: false,
    error: `${operation} is only available in the web client (termul-server)`,
    code: DESKTOP_UNSUPPORTED_CODE
  }
}

/** The `webSetupApi` surface — the renderer owner contract from `server-setup.types.ts`. */
export interface WebSetupApi {
  getStatus(): Promise<IpcResult<SetupStatusResponse>>
  validate(answers: ServerSetupAnswers): Promise<IpcResult<SetupValidateResponse>>
  apply(answers: ServerSetupAnswers): Promise<IpcResult<SetupApplyReply>>
  getServerConfig(): Promise<IpcResult<ServerConfigResponse>>
  applyServerConfig(answers: ServerSetupAnswers): Promise<IpcResult<SetupApplyReply>>
}

/**
 * The singleton `webSetupApi` per the wire contract. `getStatus`/`validate`/
 * `apply` talk to the setup-mode router under the setup token;
 * `getServerConfig`/`applyServerConfig` talk to the normal-mode
 * reconfigure routes under the regular web auth token.
 */
export const webSetupApi: WebSetupApi = {
  /** `GET /setup/status` — `setupRequired` flag + server-side defaults. */
  getStatus(): Promise<IpcResult<SetupStatusResponse>> {
    if (isTauriContext()) return Promise.resolve(desktopUnsupported('Server setup'))
    return setupGetJson<SetupStatusResponse>(SETUP_API_PATHS.status)
  },

  /** `POST /setup/validate` — dry-run validation, per-field errors. */
  validate(answers: ServerSetupAnswers): Promise<IpcResult<SetupValidateResponse>> {
    if (isTauriContext()) return Promise.resolve(desktopUnsupported('Server setup'))
    return setupPostJson<SetupValidateResponse>(SETUP_API_PATHS.validate, answers)
  },

  /**
   * `POST /setup/apply` — persist `server-config.json` and re-exec. The
   * reply ({host, port, webAuthToken?}) arrives before the ~400ms-delayed
   * restart; the wizard's restarting screen owns the reconnect/redirect.
   */
  async apply(answers: ServerSetupAnswers): Promise<IpcResult<SetupApplyReply>> {
    if (isTauriContext()) return desktopUnsupported('Server setup')
    const result = await setupPostJson<SetupApplyReply>(SETUP_API_PATHS.apply, answers)
    if (result.success) {
      // Durable boundary log (AGENTS.md): outcome only — never answers or tokens.
      void logFrontendError({
        level: 'info',
        source: LOG_SOURCE,
        message: 'setup answers accepted; the server is restarting to apply the new config'
      })
    }
    return result
  },

  /** `GET /server/config` — current effective answers for the reconfigure form. */
  getServerConfig(): Promise<IpcResult<ServerConfigResponse>> {
    if (isTauriContext()) return Promise.resolve(desktopUnsupported('Server configuration'))
    return getJson<ServerConfigResponse>(SETUP_API_PATHS.serverConfig)
  },

  /** `POST /server/config` — persist reconfigure answers + restart (same body as apply). */
  async applyServerConfig(answers: ServerSetupAnswers): Promise<IpcResult<SetupApplyReply>> {
    if (isTauriContext()) return desktopUnsupported('Server reconfiguration')
    const result = await postJson<SetupApplyReply>(SETUP_API_PATHS.serverConfig, answers)
    if (result.success) {
      void logFrontendError({
        level: 'info',
        source: LOG_SOURCE,
        message: 'reconfigured server answers accepted; the server is restarting to apply them'
      })
    }
    return result
  }
}

/** @internal Reset for tests — forgets the resolved token and the warn latch. */
export function _resetWebSetupApiForTesting(): void {
  setupToken = undefined
  warnedMissingToken = false
}
