import type { BugReportContext } from '@shared/types/bug-report.types'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingAttachment } from '@/components/chat/chat-attachments'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'
import { useReportBugStore } from '@/stores/report-bug-store'
import type { Project } from '@/types/project'
import { ReportBugDialog } from './ReportBugDialog'

// ── Mocks ────────────────────────────────────────────────────────────────
// bugReportApi/openBugReportFallback are mocked so the test controls every
// IpcResult; buildIssueMarkdown stays real — the test asserts the exact
// markdown the dialog previews and submits.
const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  submit: vi.fn(),
  fallback: vi.fn(),
  copyImage: vi.fn(),
  openUrl: vi.fn(),
  pickFiles: vi.fn(),
  handlePaste: vi.fn(),
  removeAttachment: vi.fn(),
  clearAttachments: vi.fn(),
  attachments: [] as PendingAttachment[],
  draftBugReport: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn()
  }
}))

vi.mock('@/lib/bug-report-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bug-report-api')>()
  return {
    ...actual,
    bugReportApi: {
      collectBugReportContext: mocks.collect,
      submitBugReport: mocks.submit
    },
    openBugReportFallback: mocks.fallback
  }
})

vi.mock('@/lib/tauri-opener-api', () => ({
  openerApi: { openUrlWithSystemBrowser: mocks.openUrl }
}))

vi.mock('@/components/chat/use-composer-attachments', () => ({
  useComposerAttachments: () => ({
    attachments: mocks.attachments,
    pickFiles: mocks.pickFiles,
    handlePaste: mocks.handlePaste,
    removeAttachment: mocks.removeAttachment,
    clearAttachments: mocks.clearAttachments,
    canPick: true,
    canDropPaste: true
  })
}))

vi.mock('./copy-attachment-image', () => ({
  copyAttachmentImage: mocks.copyImage
}))

vi.mock('sonner', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  toast: mocks.toast
}))

// ── Fixtures ─────────────────────────────────────────────────────────────

const CONTEXT: BugReportContext = {
  appVersion: '1.2.3',
  os: 'linux',
  arch: 'x64',
  channel: 'debug',
  runId: 'run-1',
  collectedAt: '2025-01-01T00:00:00Z',
  logAvailable: true,
  logTruncated: false,
  logTail: 'log line one'
}

const PROJECT: Project = {
  id: 'p1',
  name: 'Alpha',
  color: 'blue',
  path: '/work/alpha'
}

const IMAGE_ATT: PendingAttachment = {
  kind: 'image',
  id: 'att-1',
  name: 'screenshot.png',
  mimeType: 'image/png',
  previewUrl: 'data:image/png;base64,AAA=',
  base64: 'AAA='
}

function ok<T>(data: T) {
  return { success: true as const, data }
}

function openDialog(): void {
  act(() => useReportBugStore.getState().openReport())
}

// AttachFilesButton renders inside a Radix Tooltip; the app roots mount
// TooltipProvider globally, so the test wraps the dialog the same way.
function renderDialog(): void {
  render(
    <TooltipProvider>
      <ReportBugDialog />
    </TooltipProvider>
  )
}

describe('ReportBugDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.attachments = []
    useReportBugStore.setState({ open: false })
    useProjectStore.setState({ activeProjectId: '', projects: [] })
    useAcpStore.setState({
      selectedAgentConfigId: null,
      agentConfigs: [],
      draftBugReport: mocks.draftBugReport
    })
    mocks.collect.mockResolvedValue(ok(CONTEXT))
    mocks.submit.mockResolvedValue(
      ok({ kind: 'submitted', issueUrl: 'https://github.com/x/y/issues/1' })
    )
    mocks.fallback.mockResolvedValue({ copied: true, opened: true })
    mocks.openUrl.mockResolvedValue(ok(undefined))
    mocks.copyImage.mockResolvedValue(undefined)
    mocks.draftBugReport.mockResolvedValue(null)
  })

  it('collects diagnostics on open and previews the exact outbound markdown', async () => {
    renderDialog()
    openDialog()

    expect(mocks.collect).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Crash on split' } })
    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: 'Split a pane and the renderer crashed.' }
    })

    fireEvent.click(
      screen.getByRole('button', { name: /Preview — the exact markdown sent to GitHub/ })
    )
    const preview = await screen.findByTestId('report-markdown-preview')
    await waitFor(() => {
      expect(preview.textContent).toContain('## Crash on split')
      expect(preview.textContent).toContain('Split a pane and the renderer crashed.')
      expect(preview.textContent).toContain('- **Termul:** 1.2.3 (debug)')
      expect(preview.textContent).toContain('log line one')
    })
  })

  it('keeps the dialog usable when diagnostics collection fails', async () => {
    mocks.collect.mockResolvedValue({
      success: false,
      error: 'command not found',
      code: 'NOT_FOUND'
    })
    renderDialog()
    openDialog()

    fireEvent.click(
      screen.getByRole('button', { name: /Preview — the exact markdown sent to GitHub/ })
    )
    await screen.findByText(/Host diagnostics could not be collected/)
    const preview = screen.getByTestId('report-markdown-preview')
    await waitFor(() => {
      expect(preview.textContent).toContain('- **Termul:** unavailable')
      expect(preview.textContent).toContain('no log tail is attached')
    })

    // Submission still works — it files the honest "unavailable" bundle.
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'No diagnostics' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit report' }))
    await waitFor(() => {
      expect(mocks.submit).toHaveBeenCalledTimes(1)
    })
  })

  it('files through submitBugReport with the exact markdown and closes on submitted', async () => {
    mocks.attachments = [IMAGE_ATT]
    renderDialog()
    openDialog()
    await waitFor(() => expect(mocks.collect).toHaveBeenCalled())
    const submitButton = screen.getByRole('button', { name: 'Submit report' })
    await waitFor(() => expect(submitButton).toBeEnabled())

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Broken scroll' } })
    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: 'Scrollback jumps.' }
    })
    fireEvent.click(submitButton)

    await waitFor(() => {
      expect(mocks.submit).toHaveBeenCalledTimes(1)
    })
    const request = mocks.submit.mock.calls[0][0] as { title: string; body: string }
    expect(request.title).toBe('Broken scroll')
    // The submitted body is the same buildIssueMarkdown document the preview shows.
    expect(request.body).toContain('## Broken scroll')
    expect(request.body).toContain('Scrollback jumps.')
    expect(request.body).toContain('- **Termul:** 1.2.3 (debug)')
    expect(request.body).toContain('### Screenshots')
    expect(request.body).toContain('1 screenshot was captured')

    expect(mocks.toast.success).toHaveBeenCalledWith(
      'Bug report filed',
      expect.objectContaining({ description: 'The GitHub issue was created.' })
    )
    expect(useReportBugStore.getState().open).toBe(false)

    // The success toast's action opens the filed issue in the system browser.
    const toastCall = mocks.toast.success.mock.calls[0][1] as {
      action: { label: string; onClick: () => void }
    }
    toastCall.action.onClick()
    expect(mocks.openUrl).toHaveBeenCalledWith('https://github.com/x/y/issues/1')
  })

  it('runs the clipboard + prefilled-URL fallback when gh is unavailable', async () => {
    mocks.submit.mockResolvedValue(ok({ kind: 'unavailable', reason: 'gh not found on PATH' }))
    renderDialog()
    openDialog()
    await waitFor(() => expect(mocks.collect).toHaveBeenCalled())
    const submitButton = screen.getByRole('button', { name: 'Submit report' })
    await waitFor(() => expect(submitButton).toBeEnabled())

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'No gh' } })
    fireEvent.click(submitButton)

    await waitFor(() => {
      expect(mocks.fallback).toHaveBeenCalledTimes(1)
    })
    const [ctx, title, markdown] = mocks.fallback.mock.calls[0] as [
      BugReportContext,
      string,
      string
    ]
    expect(ctx).toEqual(CONTEXT)
    expect(title).toBe('No gh')
    expect(markdown).toContain('## No gh')
    expect(mocks.toast.info).toHaveBeenCalledWith(
      'Report copied — prefilled issue opened',
      expect.anything()
    )
    // The dialog stays open so staged screenshots can still be copied.
    expect(useReportBugStore.getState().open).toBe(true)
  })

  it('falls back on a gh failure and on a transport failure', async () => {
    mocks.submit.mockResolvedValueOnce(ok({ kind: 'failed', reason: 'gh exited 1' }))
    renderDialog()
    openDialog()
    await waitFor(() => expect(mocks.collect).toHaveBeenCalled())
    const submitButton = screen.getByRole('button', { name: 'Submit report' })
    await waitFor(() => expect(submitButton).toBeEnabled())

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'T' } })
    fireEvent.click(submitButton)
    await waitFor(() => expect(mocks.fallback).toHaveBeenCalledTimes(1))

    // Transport failure (success:false) takes the same fallback path.
    mocks.submit.mockResolvedValue({
      success: false,
      error: 'ipc down',
      code: 'IPC'
    })
    fireEvent.click(submitButton)
    await waitFor(() => expect(mocks.fallback).toHaveBeenCalledTimes(2))
  })

  it('surfaces the bounded gh failure reason in the fallback toast', async () => {
    mocks.submit.mockResolvedValue(
      ok({ kind: 'failed', reason: 'gh issue create failed: resource not accessible' })
    )
    renderDialog()
    openDialog()
    await waitFor(() => expect(mocks.collect).toHaveBeenCalled())
    const submitButton = screen.getByRole('button', { name: 'Submit report' })
    await waitFor(() => expect(submitButton).toBeEnabled())

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'T' } })
    fireEvent.click(submitButton)
    await waitFor(() => expect(mocks.fallback).toHaveBeenCalledTimes(1))

    expect(mocks.toast.info).toHaveBeenCalledWith(
      'Report copied — prefilled issue opened',
      expect.objectContaining({
        description: expect.stringContaining('resource not accessible')
      })
    )
  })

  it('names the transport, not the CLI, when the submit command never ran', async () => {
    mocks.submit.mockResolvedValue({ success: false, error: 'ipc down', code: 'IPC' })
    renderDialog()
    openDialog()
    await waitFor(() => expect(mocks.collect).toHaveBeenCalled())
    const submitButton = screen.getByRole('button', { name: 'Submit report' })
    await waitFor(() => expect(submitButton).toBeEnabled())

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'T' } })
    fireEvent.click(submitButton)
    await waitFor(() => expect(mocks.fallback).toHaveBeenCalledTimes(1))

    const description = String(
      (mocks.toast.info.mock.calls[0]?.[1] as { description?: string })?.description ?? ''
    )
    expect(description).toContain('transport')
    expect(description).not.toContain('gh ')
  })

  it('requires a title before submitting', async () => {
    let resolveCollect: (value: ReturnType<typeof ok>) => void = () => {}
    mocks.collect.mockReturnValue(
      new Promise((resolve) => {
        resolveCollect = resolve
      })
    )
    renderDialog()
    openDialog()
    const submitButton = screen.getByRole('button', { name: 'Submit report' })
    // Submit stays disabled while the diagnostics collect is in flight — the
    // user must be able to preview the exact outbound markdown first.
    expect(submitButton).toBeDisabled()
    expect(submitButton).toHaveAttribute('title', 'Collecting diagnostics…')
    await act(async () => {
      resolveCollect(ok(CONTEXT))
    })
    await waitFor(() => expect(submitButton).toBeEnabled())
    fireEvent.click(submitButton)
    expect(await screen.findByText('Give the report a short title.')).toBeInTheDocument()
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('hides Draft with AI when no agent is configured, drafts on explicit click when one is', async () => {
    renderDialog()
    openDialog()
    await waitFor(() => expect(mocks.collect).toHaveBeenCalled())

    expect(screen.queryByRole('button', { name: /Draft with AI/ })).not.toBeInTheDocument()

    // A selected + configured agent and a project cwd gate the button in.
    act(() => {
      useProjectStore.setState({ activeProjectId: 'p1', projects: [PROJECT] })
      useAcpStore.setState({
        selectedAgentConfigId: 'cfg-1',
        agentConfigs: [{ id: 'cfg-1', name: 'Agent', command: 'agent', args: [], env: {} }]
      })
    })
    const draftButton = await screen.findByRole('button', { name: /Draft with AI/ })
    expect(draftButton).toBeEnabled()

    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: 'Typed description' }
    })
    mocks.draftBugReport.mockResolvedValue({ title: 'AI title', body: 'AI body' })
    fireEvent.click(draftButton)

    await waitFor(() => expect(mocks.draftBugReport).toHaveBeenCalledTimes(1))
    expect(mocks.draftBugReport).toHaveBeenCalledWith({
      cwd: '/work/alpha',
      userDescription: 'Typed description',
      diagnostics: CONTEXT
    })
    await waitFor(() => {
      expect(screen.getByLabelText('Title')).toHaveValue('AI title')
      expect(screen.getByLabelText('What happened?')).toHaveValue('AI body')
    })
  })

  it('keeps the user text and toasts when the AI draft fails', async () => {
    useProjectStore.setState({ activeProjectId: 'p1', projects: [PROJECT] })
    useAcpStore.setState({
      selectedAgentConfigId: 'cfg-1',
      agentConfigs: [{ id: 'cfg-1', name: 'Agent', command: 'agent', args: [], env: {} }]
    })
    mocks.draftBugReport.mockResolvedValue(null)
    renderDialog()
    openDialog()
    await waitFor(() => expect(mocks.collect).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'My title' } })
    fireEvent.click(await screen.findByRole('button', { name: /Draft with AI/ }))

    await waitFor(() => {
      expect(mocks.toast.error).toHaveBeenCalledWith('AI draft unavailable', expect.anything())
    })
    expect(screen.getByLabelText('Title')).toHaveValue('My title')
  })

  it('offers a copy-image affordance per staged screenshot', async () => {
    mocks.attachments = [IMAGE_ATT]
    renderDialog()
    openDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Copy screenshot.png to clipboard' }))
    await waitFor(() => expect(mocks.copyImage).toHaveBeenCalledWith(IMAGE_ATT))
    expect(mocks.toast.success).toHaveBeenCalledWith(
      'Image copied — paste it into the GitHub issue'
    )
  })

  it('routes paste events to the composer attachment handler', () => {
    renderDialog()
    openDialog()
    fireEvent.paste(screen.getByLabelText('What happened?'), {
      clipboardData: { getData: () => '', files: [], items: [] }
    })
    expect(mocks.handlePaste).toHaveBeenCalledTimes(1)
  })
})
