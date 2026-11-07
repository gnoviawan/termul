import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invokeIpc: vi.fn(),
  postJson: vi.fn(),
  isTauriContext: vi.fn(() => true),
  copyText: vi.fn(async () => true),
  logFrontendError: vi.fn(async () => undefined),
  openUrlWithSystemBrowser: vi.fn(async () => ({ success: true as const, data: undefined }))
}))

vi.mock('@/lib/tauri-runtime', () => ({ isTauriContext: mocks.isTauriContext }))
vi.mock('@/lib/ipc/tauri', () => ({ invokeIpc: mocks.invokeIpc }))
vi.mock('@/lib/ipc/http', () => ({ postJson: mocks.postJson }))
vi.mock('@/lib/copy-text', () => ({ copyText: mocks.copyText }))
vi.mock('@/lib/log-api', () => ({ logFrontendError: mocks.logFrontendError }))
vi.mock('@/lib/tauri-opener-api', () => ({
  openerApi: { openUrlWithSystemBrowser: mocks.openUrlWithSystemBrowser }
}))

import type { BugReportContext } from '@shared/types/bug-report.types'
import {
  bugReportApi,
  buildIssueMarkdown,
  buildIssueUrl,
  copyBugReportToClipboard,
  ISSUE_URL_MAX_CHARS,
  openBugReportFallback
} from './bug-report-api'

const context: BugReportContext = {
  appVersion: '0.9.0',
  os: 'linux',
  arch: 'x86_64',
  channel: 'debug',
  runId: 'run-1234',
  collectedAt: '2026-10-19T12:00:00Z',
  logAvailable: true,
  logTruncated: false,
  logTail: 'line one\nline two'
}

describe('bugReportApi transport parity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isTauriContext.mockReturnValue(true)
    mocks.copyText.mockResolvedValue(true)
    mocks.openUrlWithSystemBrowser.mockResolvedValue({ success: true, data: undefined })
  })

  it('desktop: collectBugReportContext invokes collect_bug_report_context', async () => {
    mocks.invokeIpc.mockResolvedValueOnce({ success: true, data: context })

    const result = await bugReportApi.collectBugReportContext()

    expect(mocks.invokeIpc).toHaveBeenCalledWith('collect_bug_report_context')
    expect(mocks.postJson).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, data: context })
  })

  it('desktop: submitBugReport invokes submit_bug_report with {title, body}', async () => {
    const submitted = {
      kind: 'submitted',
      issueUrl: 'https://github.com/gnoviawan/termul/issues/1'
    }
    mocks.invokeIpc.mockResolvedValueOnce({ success: true, data: submitted })

    const result = await bugReportApi.submitBugReport({ title: 'T', body: 'B' })

    expect(mocks.invokeIpc).toHaveBeenCalledWith('submit_bug_report', { title: 'T', body: 'B' })
    expect(mocks.postJson).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, data: submitted })
  })

  it('web: collectBugReportContext POSTs /log/diagnostics with an empty body', async () => {
    mocks.isTauriContext.mockReturnValue(false)
    mocks.postJson.mockResolvedValueOnce({ success: true, data: context })

    const result = await bugReportApi.collectBugReportContext()

    expect(mocks.postJson).toHaveBeenCalledWith('/log/diagnostics', {})
    expect(mocks.invokeIpc).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, data: context })
  })

  it('web: submitBugReport POSTs /log/report-bug with the request body verbatim', async () => {
    mocks.isTauriContext.mockReturnValue(false)
    mocks.postJson.mockResolvedValueOnce({
      success: true,
      data: { kind: 'unavailable', reason: 'gh CLI is not available' }
    })

    const request = { title: 'T', body: 'B' }
    const result = await bugReportApi.submitBugReport(request)

    expect(mocks.postJson).toHaveBeenCalledWith('/log/report-bug', request)
    expect(mocks.invokeIpc).not.toHaveBeenCalled()
    expect(result.success && result.data.kind).toBe('unavailable')
  })

  it('passes a transport IpcResult failure through without throwing (web 401 shape)', async () => {
    mocks.isTauriContext.mockReturnValue(false)
    mocks.postJson.mockResolvedValueOnce({
      success: false,
      error: 'Unauthorized',
      code: 'UNAUTHORIZED'
    })

    const result = await bugReportApi.collectBugReportContext()

    expect(result).toEqual({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' })
  })

  it('logs a boundary line (never contents) when submit reports an unavailable gh', async () => {
    mocks.invokeIpc.mockResolvedValueOnce({
      success: true,
      data: { kind: 'unavailable', reason: 'gh CLI is not available' }
    })

    await bugReportApi.submitBugReport({ title: 'secret title', body: 'secret body' })

    expect(mocks.logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'bug-report-api.submitBugReport' })
    )
    const logged = mocks.logFrontendError.mock.calls.map((c) => c[0]?.message ?? '').join('\n')
    expect(logged).toContain('unavailable')
    expect(logged).not.toContain('secret title')
    expect(logged).not.toContain('secret body')
  })
})

describe('buildIssueUrl', () => {
  it('carries title + the full body when it fits the ~8KB budget', () => {
    const body = buildIssueMarkdown(context, 'Tiny bug', 'It broke')
    const url = buildIssueUrl(context, 'Tiny bug', body, true)

    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX_CHARS)
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://github.com/gnoviawan/termul/issues/new')
    expect(parsed.searchParams.get('title')).toBe('Tiny bug')
    expect(parsed.searchParams.get('body')).toBe(body)
    expect(parsed.searchParams.has('labels')).toBe(false)
  })

  it('splits to title + env summary + clipboard note when the body overflows', () => {
    const bigBody = `start\n${'x'.repeat(20_000)}\nend`
    const url = buildIssueUrl(context, 'Huge bug', bigBody, true)

    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX_CHARS)
    const parsed = new URL(url)
    expect(parsed.searchParams.get('title')).toBe('Huge bug')
    const body = parsed.searchParams.get('body') ?? ''
    // The full body is gone; the compact env summary + clipboard note remain.
    expect(body).not.toContain('x'.repeat(100))
    expect(body).toContain('was copied to the clipboard')
    expect(body).toContain('0.9.0')
    expect(body).toContain('linux')
    expect(body).toContain('run-1234')
    expect(parsed.searchParams.has('labels')).toBe(false)
  })

  it('points at the dialog preview instead of the clipboard when the copy failed', () => {
    const bigBody = `start\n${'x'.repeat(20_000)}\nend`
    const url = buildIssueUrl(context, 'Huge bug', bigBody, false)

    const parsed = new URL(url)
    const body = parsed.searchParams.get('body') ?? ''
    expect(body).not.toContain('was copied to the clipboard')
    expect(body).toContain("dialog's preview")
  })

  it('never emits a labels parameter even on the full-body path', () => {
    expect(buildIssueUrl(context, 't', 'b', true)).not.toContain('labels')
  })

  it('truncates a pathological title so the URL still fits', () => {
    const url = buildIssueUrl(context, 't'.repeat(40_000), 'x'.repeat(20_000), true)

    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX_CHARS)
    const parsed = new URL(url)
    expect((parsed.searchParams.get('title') ?? '').length).toBeLessThan(40_000)
    expect(parsed.searchParams.get('body')).toContain('clipboard')
  })
})

describe('buildIssueMarkdown', () => {
  it('composes title, description, environment block, and a <details> log tail', () => {
    const markdown = buildIssueMarkdown(context, 'The bug', 'It broke when I clicked')

    expect(markdown).toContain('## The bug')
    expect(markdown).toContain('It broke when I clicked')
    expect(markdown).toContain('### Environment')
    expect(markdown).toContain('0.9.0')
    expect(markdown).toContain('debug')
    expect(markdown).toContain('linux')
    expect(markdown).toContain('x86_64')
    expect(markdown).toContain('run-1234')
    expect(markdown).toContain('2026-10-19T12:00:00Z')
    expect(markdown).toContain('<details>')
    expect(markdown).toContain('<summary>termul.log tail</summary>')
    expect(markdown).toContain('```text')
    expect(markdown).toContain('line one\nline two')
    expect(markdown).toContain('</details>')
  })

  it('notes the missing log instead of a details block when logAvailable is false', () => {
    const markdown = buildIssueMarkdown({ ...context, logAvailable: false, logTail: '' }, 'T', 'D')

    expect(markdown).not.toContain('<details>')
    expect(markdown).toMatch(/log.*unavailable/i)
  })

  it('marks a truncated tail in the details summary', () => {
    const markdown = buildIssueMarkdown({ ...context, logTruncated: true }, 'T', 'D')
    expect(markdown).toMatch(/<summary>termul\.log tail \(truncated/)
  })

  it('adds the screenshots note only when screenshots exist', () => {
    expect(buildIssueMarkdown(context, 'T', 'D', 0)).not.toContain('### Screenshots')
    const withShots = buildIssueMarkdown(context, 'T', 'D', 2)
    expect(withShots).toContain('### Screenshots')
    expect(withShots).toContain('2 screenshots')
  })

  it('widens the code fence one char past the longest backtick run in the tail', () => {
    const markdown = buildIssueMarkdown({ ...context, logTail: 'before\n```\nafter' }, 'T', 'D')
    expect(markdown).toContain('````text')
    expect(markdown).toContain('before\n```\nafter')
  })

  it('out-runs a longer backtick run so the tail can never close the fence', () => {
    const tail = 'x\n`````\ny'
    const markdown = buildIssueMarkdown({ ...context, logTail: tail }, 'T', 'D')
    expect(markdown).toContain('``````text')
    expect(markdown).toContain(`\n${tail}\n`)
  })

  it('ignores tilde runs — they cannot close a backtick fence', () => {
    const tail = 'a\n~~~~\nb'
    const markdown = buildIssueMarkdown({ ...context, logTail: tail }, 'T', 'D')
    expect(markdown).toContain(`\`\`\`text\n${tail}\n\`\`\``)
  })
})

describe('copyBugReportToClipboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.copyText.mockResolvedValue(true)
  })

  it('delegates to copyText and returns its result', async () => {
    mocks.copyText.mockResolvedValueOnce(true)
    await expect(copyBugReportToClipboard('# md')).resolves.toBe(true)
    expect(mocks.copyText).toHaveBeenCalledWith('# md')
  })

  it('returns false and logs (without contents) when every copy strategy fails', async () => {
    mocks.copyText.mockResolvedValueOnce(false)
    await expect(copyBugReportToClipboard('secret md')).resolves.toBe(false)
    expect(mocks.logFrontendError).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'bug-report-api.copyBugReportToClipboard' })
    )
    const logged = mocks.logFrontendError.mock.calls.map((c) => c[0]?.message ?? '').join('\n')
    expect(logged).not.toContain('secret md')
  })

  it('returns false when copyText throws', async () => {
    mocks.copyText.mockRejectedValueOnce(new Error('denied'))
    await expect(copyBugReportToClipboard('# md')).resolves.toBe(false)
  })
})

describe('openBugReportFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.copyText.mockResolvedValue(true)
    mocks.openUrlWithSystemBrowser.mockResolvedValue({ success: true, data: undefined })
  })

  it('copies the full markdown, then opens the prefilled issue URL', async () => {
    const markdown = buildIssueMarkdown(context, 'Bug', 'Details')
    const outcome = await openBugReportFallback(context, 'Bug', markdown)

    expect(mocks.copyText).toHaveBeenCalledWith(markdown)
    expect(mocks.openUrlWithSystemBrowser).toHaveBeenCalledTimes(1)
    const url = mocks.openUrlWithSystemBrowser.mock.calls[0][0] as string
    expect(url).toContain('https://github.com/gnoviawan/termul/issues/new?title=')
    expect(url.length).toBeLessThanOrEqual(ISSUE_URL_MAX_CHARS)
    expect(outcome).toEqual({ copied: true, opened: true })
  })

  it('still opens the URL when the clipboard copy fails, and reports both halves', async () => {
    mocks.copyText.mockResolvedValueOnce(false)
    mocks.openUrlWithSystemBrowser.mockResolvedValueOnce({
      success: false,
      error: 'no handler',
      code: 'OPEN_URL_ERROR'
    })

    const outcome = await openBugReportFallback(context, 'Bug', 'md')

    expect(mocks.openUrlWithSystemBrowser).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ copied: false, opened: false })
  })

  it('tells the reader to copy from the preview when the clipboard copy failed', async () => {
    mocks.copyText.mockResolvedValueOnce(false)
    // Over the URL budget so the URL carries the short body, not the markdown.
    const markdown = `start\n${'x'.repeat(20_000)}\nend`

    const outcome = await openBugReportFallback(context, 'Bug', markdown)

    expect(outcome).toEqual({ copied: false, opened: true })
    const url = mocks.openUrlWithSystemBrowser.mock.calls[0][0] as string
    const body = new URL(url).searchParams.get('body') ?? ''
    expect(body).toContain("dialog's preview")
    expect(body).not.toContain('was copied to the clipboard')
  })
})
