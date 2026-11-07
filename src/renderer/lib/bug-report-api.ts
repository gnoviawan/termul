/**
 * Bug report facade (spec-bug-report-dialog).
 *
 * One facade over the two host transports the report flow ships on:
 *
 * - Desktop: the `collect_bug_report_context` / `submit_bug_report` Tauri
 *   commands (commands module + `invoke_handler`), each returning the shared
 *   `IpcResult<T>` contract — hence `invokeIpc`, not `invokeIpcWrapped`.
 * - Web/remote + `termul-server`: `POST /log/diagnostics` (empty body) and
 *   `POST /log/report-bug` (`BugReportSubmitRequest`), replying `IpcBody<T>`
 *   — the `IpcResult<T>` byte-shape `postJson` already parses (the `/log/`
 *   prefix inherits the server's `GATED_PREFIXES` bearer auth, so an
 *   unauthenticated peer's call surfaces here as the preserved `UNAUTHORIZED`
 *   failure).
 *
 * `collectBugReportContext` returns the bounded, already-redacted diagnostics
 * bundle (nothing the renderer renders was unredacted). `submitBugReport`
 * returns the host `gh` outcome as data — `submitted` carries the filed issue
 * URL; `unavailable`/`failed` send the caller down {@link openBugReportFallback}
 * (full markdown on the clipboard + a prefilled `issues/new` URL). A
 * `success: false` `IpcResult` is a transport/IPC failure, not a `gh` verdict.
 *
 * Boundary/failure logging goes through `logFrontendError`; the report's
 * title/body/diagnostics contents are NEVER logged (only codes, result kinds,
 * and the host's already-redacted bounded reasons).
 */

import type {
  BugReportContext,
  BugReportSubmitRequest,
  BugReportSubmitResult
} from '@shared/types/bug-report.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { copyText } from './copy-text'
import { postJson } from './ipc/http'
import { invokeIpc } from './ipc/tauri'
import { logFrontendError } from './log-api'
import { openerApi } from './tauri-opener-api'
import { isTauriContext } from './tauri-runtime'

function logBoundary(source: string, message: string): void {
  void logFrontendError({ level: 'warn', source, message })
}

/**
 * Bug report host ops. Both branches resolve to the same `IpcResult<T>`
 * contract; neither throws (IPC/network failures arrive as
 * `success: false` results).
 */
export const bugReportApi = {
  /**
   * Collect the redacted diagnostics bundle the dialog previews. Desktop
   * invokes `collect_bug_report_context`; web POSTs `/log/diagnostics`.
   */
  async collectBugReportContext(): Promise<IpcResult<BugReportContext>> {
    const result = isTauriContext()
      ? await invokeIpc<BugReportContext>('collect_bug_report_context')
      : await postJson<BugReportContext>('/log/diagnostics', {})
    if (!result.success) {
      logBoundary(
        'bug-report-api.collectBugReportContext',
        `collect_bug_report_context failed (code=${result.code})`
      )
    }
    return result
  },

  /**
   * File the report through the host `gh issue create`. Desktop invokes
   * `submit_bug_report` with `{ title, body }`; web POSTs `/log/report-bug`
   * with the same body. The `kind` field on a successful result tells the
   * caller whether to show the issue URL (`submitted`) or run the
   * clipboard + prefilled-URL fallback (`unavailable` / `failed`).
   */
  async submitBugReport(
    request: BugReportSubmitRequest
  ): Promise<IpcResult<BugReportSubmitResult>> {
    const result = isTauriContext()
      ? await invokeIpc<BugReportSubmitResult>('submit_bug_report', {
          title: request.title,
          body: request.body
        })
      : await postJson<BugReportSubmitResult>('/log/report-bug', request)
    if (!result.success) {
      logBoundary(
        'bug-report-api.submitBugReport',
        `submit_bug_report failed (code=${result.code})`
      )
    } else if (result.data.kind === 'submitted') {
      // Durable boundary log for the filed issue; the URL is not report
      // content and is already logged host-side.
      void logFrontendError({
        level: 'info',
        source: 'bug-report-api.submitBugReport',
        message: `submit_bug_report filed issue ${result.data.issueUrl}`
      })
    } else {
      // `reason` is host-produced — static text or the bounded, redacted
      // `gh` stderr — never report contents.
      logBoundary(
        'bug-report-api.submitBugReport',
        `submit_bug_report returned ${result.data.kind}: ${result.data.reason}`
      )
    }
    return result
  }
}

/** Repo the report files against (host `gh` uses the same `-R` target). */
const ISSUE_REPO = 'gnoviawan/termul'
const ISSUE_NEW_URL = `https://github.com/${ISSUE_REPO}/issues/new`

/**
 * ~8KB cap on the `issues/new` prefill URL (spec: "body >~8KB → URL carries
 * title + short body"). Longer URLs risk the prefill being dropped by the
 * browser/GitHub, so past the budget the URL degrades to a compact body.
 */
export const ISSUE_URL_MAX_CHARS = 8000

/**
 * Build the full report markdown: title, description, environment block,
 * `<details>` log tail, and the screenshots note. This is the standalone
 * document that lands on the clipboard for the fallback and becomes the
 * `body` sent to `submit_bug_report` / the `issues/new` prefill.
 */
export function buildIssueMarkdown(
  context: BugReportContext,
  title: string,
  description: string,
  screenshotCount = 0
): string {
  const trimmedTitle = title.trim()
  const trimmedDescription = description.trim()
  const lines: string[] = []

  lines.push(`## ${trimmedTitle || 'Bug report'}`)
  lines.push('')
  lines.push(trimmedDescription || '_No description provided._')
  lines.push('')
  lines.push('### Environment')
  lines.push('')
  lines.push(`- **Termul:** ${context.appVersion} (${context.channel})`)
  lines.push(`- **OS:** ${context.os} (${context.arch})`)
  lines.push(`- **Run ID:** ${context.runId}`)
  lines.push(`- **Collected:** ${context.collectedAt}`)
  lines.push('')

  if (context.logAvailable) {
    // The tail is already redacted host-side; render it verbatim inside a
    // collapsed details block. A log line may itself contain a backtick run —
    // CommonMark closes a fenced block only on a run of the SAME fence char at
    // least as long as the opening fence, so a backtick fence one char longer
    // than the longest backtick run in the tail can never be closed early
    // (tilde runs cannot close a backtick fence either).
    let longestBacktickRun = 0
    for (const run of context.logTail.matchAll(/`+/g)) {
      longestBacktickRun = Math.max(longestBacktickRun, run[0].length)
    }
    const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1))
    const summary = context.logTruncated
      ? 'termul.log tail (truncated to its byte bound)'
      : 'termul.log tail'
    lines.push('<details>')
    lines.push(`<summary>${summary}</summary>`)
    lines.push('')
    lines.push(`${fence}text`)
    lines.push(context.logTail)
    lines.push(fence)
    lines.push('')
    lines.push('</details>')
  } else {
    // A missing/unreadable host log is a note, not an error (spec matrix).
    lines.push('_The host log (termul.log) was unavailable, so no log tail is attached._')
  }

  if (screenshotCount > 0) {
    // GitHub/`gh` have no image-attach path on issue creation — the report
    // dialog exposes a per-attachment copy-image button instead.
    lines.push('')
    lines.push('### Screenshots')
    lines.push('')
    const plural = screenshotCount === 1 ? 'screenshot was' : 'screenshots were'
    lines.push(
      `${screenshotCount} ${plural} captured for this report. Images cannot be ` +
        'attached during issue creation — copy each screenshot in the report ' +
        'dialog and paste it into this issue.'
    )
  }

  return `${lines.join('\n')}\n`
}

/**
 * The compact body the fallback URL carries when the full markdown overflows
 * the budget: a where-the-rest-of-the-report-is note plus the environment
 * block (rebuilt from `context`) so the filed issue still names
 * version/OS/run. The note is honest about the clipboard outcome: `copied`
 * says the full report is on the clipboard; `!copied` sends the reader back
 * to the dialog's preview instead of claiming a copy that never landed.
 */
function shortIssueBody(context: BugReportContext, copied: boolean): string {
  const note = copied
    ? '_The full report (description, diagnostics, and log tail) was copied to the clipboard — paste it into this issue to complete the report._'
    : "_The full report (description, diagnostics, and log tail) could not be copied to the clipboard — copy the report text from the dialog's preview and paste it into this issue._"
  return [
    note,
    '',
    '### Environment',
    '',
    `- **Termul:** ${context.appVersion} (${context.channel})`,
    `- **OS:** ${context.os} (${context.arch})`,
    `- **Run ID:** ${context.runId}`,
    `- **Collected:** ${context.collectedAt}`
  ].join('\n')
}

/**
 * Build the prefilled `issues/new` fallback URL. Carries `title` + the full
 * `body` when that fits {@link ISSUE_URL_MAX_CHARS}; otherwise `title` +
 * {@link shortIssueBody} (a where-the-report-is note + the environment
 * block). `copied` is the clipboard outcome so the short body can honestly
 * direct the reader to the clipboard or back to the dialog's preview. A
 * pathological title that still overflows is truncated in the URL only.
 * `labels` is never emitted — issue creation without triage permission can
 * 404 on it.
 */
export function buildIssueUrl(
  context: BugReportContext,
  title: string,
  body: string,
  copied: boolean
): string {
  const urlFor = (t: string, b: string) =>
    `${ISSUE_NEW_URL}?title=${encodeURIComponent(t)}&body=${encodeURIComponent(b)}`
  const full = urlFor(title, body)
  if (full.length <= ISSUE_URL_MAX_CHARS) return full
  const shortBody = shortIssueBody(context, copied)
  let shortTitle = title
  while (shortTitle.length > 0 && urlFor(shortTitle, shortBody).length > ISSUE_URL_MAX_CHARS) {
    shortTitle = shortTitle.slice(0, Math.ceil(shortTitle.length / 2))
  }
  return urlFor(shortTitle, shortBody)
}

/**
 * Copy the full report markdown to the clipboard via the canonical
 * `copyText` helper (Tauri clipboard plugin → the Async Clipboard API →
 * hidden-textarea `execCommand`, covering the non-secure web context).
 * Returns whether the copy landed; failures are logged without the contents.
 */
export async function copyBugReportToClipboard(markdown: string): Promise<boolean> {
  try {
    const copied = await copyText(markdown)
    if (!copied) {
      logBoundary(
        'bug-report-api.copyBugReportToClipboard',
        'clipboard copy failed — every strategy returned without copying'
      )
    }
    return copied
  } catch (error) {
    logBoundary(
      'bug-report-api.copyBugReportToClipboard',
      `clipboard copy threw: ${error instanceof Error ? error.message : String(error)}`
    )
    return false
  }
}

/** Outcome of {@link openBugReportFallback}; each side reports independently. */
export interface BugReportFallbackOutcome {
  /** True when the full markdown reached the clipboard. */
  copied: boolean
  /** True when the prefilled issue URL was handed to the browser. */
  opened: boolean
}

/**
 * The `gh`-unavailable/`gh`-failed path: put the full markdown on the
 * clipboard, then open the prefilled `issues/new` URL via `openerApi`
 * (`openUrl` on desktop, `window.open` on web). The clipboard copy runs
 * first so the URL's short body can truthfully claim the full report was
 * copied.
 */
export async function openBugReportFallback(
  context: BugReportContext,
  title: string,
  markdown: string
): Promise<BugReportFallbackOutcome> {
  const copied = await copyBugReportToClipboard(markdown)
  const openResult = await openerApi.openUrlWithSystemBrowser(
    buildIssueUrl(context, title, markdown, copied)
  )
  if (!openResult.success) {
    logBoundary(
      'bug-report-api.openBugReportFallback',
      `opening the prefilled issue failed (code=${openResult.code})`
    )
  }
  return { copied, opened: openResult.success }
}
