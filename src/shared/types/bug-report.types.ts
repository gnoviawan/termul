// In-app bug report wire contract (spec-bug-report-dialog). Shared by the
// Tauri `collect_bug_report_context` / `submit_bug_report` commands and the
// `/log/*` web routes. Runtime-neutral: no Tauri or DOM imports. camelCase
// shapes mirror the serde types in `src-tauri/src/diagnostics.rs` exactly.

/**
 * Diagnostics bundle collected host-side when the report dialog opens.
 * `logTail` is already deterministically redacted (secret patterns plus a
 * home-dir scrub) — renderers and agents only ever see this redacted text.
 */
export interface BugReportContext {
  /** `env!("CARGO_PKG_VERSION")` of the host build. */
  appVersion: string
  /** `std::env::consts::OS`. */
  os: string
  /** `std::env::consts::ARCH`. */
  arch: string
  /** Build channel: `debug` or `release`. */
  channel: string
  /** Per-run host correlation id (`crate::logging::run_id`). */
  runId: string
  /** RFC 3339 timestamp of the collect. */
  collectedAt: string
  /** False when the log file was missing/unreadable — a note, not an error. */
  logAvailable: boolean
  /** True when the tail was cut to its byte bound and the file start dropped. */
  logTruncated: boolean
  /** Bounded redacted log tail; empty when `logAvailable` is false. */
  logTail: string
}

/** Report fields the user previews/edits before anything leaves the host. */
export interface BugReportSubmitRequest {
  title: string
  body: string
}

/**
 * `gh` submit outcome. `unavailable` (no `gh` on PATH, not authenticated, or
 * the process could not spawn) sends the caller down the clipboard +
 * prefilled-URL fallback; `failed` is a real submission error worth
 * surfacing. `kind` is the serde tag of the Rust enum.
 */
export type BugReportSubmitResult =
  | { kind: 'submitted'; issueUrl: string }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string }
