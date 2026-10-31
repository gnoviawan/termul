// Web onboarding / server reconfigure wire contract (gh-1105).
//
// Shared between the `termul-server` setup router (`src-tauri/src/web/setup.rs`),
// the normal-mode reconfigure routes (`/server/config` in `web/router.rs`), and
// the web renderer. Field names are camelCase and intentionally identical to
// the persisted `server-config.json` (`web/server_config_file.rs`) so the file,
// the API, and the wizard never drift.
//
// Renderer-side owners (single source of truth for the slice boundary):
//   - `lib/web-setup-api.ts`    exports singleton `webSetupApi` with:
//       getStatus():        Promise<IpcResult<SetupStatusResponse>>
//       validate(answers):  Promise<IpcResult<SetupValidateResponse>>
//       apply(answers):     Promise<IpcResult<SetupApplyResponse>>
//       getServerConfig():  Promise<IpcResult<ServerConfigResponse>>   (web-auth'd)
//       applyServerConfig(answers): Promise<IpcResult<SetupApplyResponse>> (web-auth'd)
//     The setup token comes from `?setup=<token>` (see SETUP_TOKEN_PARAM) and is
//     sent as `Authorization: Bearer` on /setup/* only — never persisted to
//     localStorage (it dies with the setup-mode process).
//   - `lib/web-setup-gate.ts`   exports `useWebSetupGate()` -> 'checking' | 'setup' | 'ok',
//     probing `${location.origin}/health` for `setupRequired` (web-only; the
//     desktop root never mounts it).
//   - `components/setup/ServerSetupGate.tsx` exports `ServerSetupGate({children})`
//     — renders children normally, the wizard full-screen while gate === 'setup'.
//   - `components/setup/ServerSetupWizard.tsx` exports `ServerSetupWizard` with
//     props `{ mode: 'setup' | 'reconfigure'; initial?: ServerSetupAnswers }`.

/** Query param carrying the one-time setup token printed at setup-mode boot. */
export const SETUP_TOKEN_PARAM = 'setup'

export const SETUP_API_PATHS = {
  status: '/setup/status',
  validate: '/setup/validate',
  apply: '/setup/apply',
  serverConfig: '/server/config'
} as const

export type ServerUpdateChannel = 'stable' | 'insider' | 'nightly'

/** The wizard answers — same fields as `server-config.json`. */
export interface ServerSetupAnswers {
  /** `127.0.0.1` (localhost only) or `0.0.0.0` (all interfaces). */
  host: string
  port: number
  sessionsDir: string
  projectsFile: string
  allowRemoteWrites: boolean
  updateChannel: ServerUpdateChannel | null
  updateIntervalSecs: number
}

/** `GET /health` gains `setupRequired` (server HealthBody). */
export interface SetupStatusResponse {
  setupRequired: boolean
  /**
   * Present when setup mode is running because an existing
   * `server-config.json` failed to load (corrupt or semantically invalid) —
   * the load error text, so the wizard can explain the recovery instead of
   * silently re-onboarding.
   */
  configError?: string
  /** Server-side defaults (`OnboardAnswers::defaults()`) to pre-fill the form. */
  defaults: ServerSetupAnswers
}

/** Per-field errors; absent field = valid. */
export interface SetupFieldErrors {
  host?: string
  port?: string
  sessionsDir?: string
  projectsFile?: string
  allowRemoteWrites?: string
  updateChannel?: string
  updateIntervalSecs?: string
}

export interface SetupValidateResponse {
  ok: boolean
  fieldErrors: SetupFieldErrors
}

/**
 * `POST /setup/apply` + `POST /server/config` success body. The server restarts
 * ~400ms after replying. `webAuthToken` is present when the post-setup bind is
 * non-loopback and the server generated/loaded a web auth token — the client
 * lands on the new origin via `#token=` so it is authenticated immediately.
 */
export interface SetupApplyResponse {
  ok: true
  /** Effective host/port the server will bind after restart. */
  host: string
  port: number
  webAuthToken?: string
}

/**
 * The apply rejection verdict — server-side validation failed. Same
 * `{ok:false, fieldErrors}` shape as the `/setup/validate` dry-run reply;
 * both apply routes answer it at 200 inside the IpcBody envelope so the
 * per-field errors reach `result.data` (a non-2xx status would collapse to
 * NETWORK_ERROR before `data` was read).
 */
export interface SetupApplyRejected {
  ok: false
  fieldErrors: SetupFieldErrors
}

/** `data` of a `/setup/apply` or `/server/config` reply — narrow on `ok`. */
export type SetupApplyReply = SetupApplyResponse | SetupApplyRejected

/** `GET /server/config` — current effective answers for the reconfigure form. */
export interface ServerConfigResponse {
  config: ServerSetupAnswers
}
