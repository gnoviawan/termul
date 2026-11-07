/**
 * Report a Bug dialog (spec-bug-report-dialog).
 *
 * One dialog for every surface: it collects the host's redacted
 * diagnostics on open, lets the user preview and edit the EXACT outbound
 * markdown, stages local screenshots (never uploaded — a per-attachment
 * "copy image" button is the user's path into the filed GitHub issue),
 * and files through the host `gh` (`submitBugReport`) or, when `gh` is
 * unavailable/fails, the clipboard + prefilled `issues/new` fallback.
 *
 * Nothing here is automatic: collection starts when the dialog opens,
 * drafting runs only on the "Draft with AI" click, and submission runs
 * only on "Submit report". Report title/body/markdown/diagnostics are
 * never logged — boundary logs carry kinds and counts only.
 */

import type { BugReportContext } from '@shared/types/bug-report.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AttachFilesButton } from '@/components/chat/AttachFilesButton'
import { AttachmentPreviewGroup } from '@/components/chat/AttachmentPreviewGroup'
import { isImageMime, type PendingAttachment } from '@/components/chat/chat-attachments'
import { useComposerAttachments } from '@/components/chat/use-composer-attachments'
import { Bug, Check, ChevronDown, Copy, LoaderCircle, Sparkles } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { bugReportApi, buildIssueMarkdown, openBugReportFallback } from '@/lib/bug-report-api'
import { logFrontendError } from '@/lib/log-api'
import { openerApi } from '@/lib/tauri-opener-api'
import { cn } from '@/lib/utils'
import { getDefaultCwdForProject } from '@/lib/worktree-context'
import { useAcpStore } from '@/stores/acp-store'
import { useActiveProjectId, useProjectStore } from '@/stores/project-store'
import { useReportBugOpen, useReportBugStore } from '@/stores/report-bug-store'
import { copyAttachmentImage } from './copy-attachment-image'

/**
 * Placeholder diagnostics used when host collection fails: the report
 * must still work end-to-end, so the markdown carries honest
 * "unavailable" environment fields and the standard no-log-tail note
 * instead of a fabricated bundle.
 */
const DIAGNOSTICS_UNAVAILABLE: BugReportContext = {
  appVersion: 'unavailable',
  os: 'unavailable',
  arch: 'unavailable',
  channel: 'unavailable',
  runId: 'unavailable',
  collectedAt: 'unavailable',
  logAvailable: false,
  logTruncated: false,
  logTail: ''
}

type CollectStatus = 'collecting' | 'ready' | 'unavailable'

function logBoundary(message: string): void {
  // Boundary only — never the report title, body, diagnostics, or image data.
  void logFrontendError({ level: 'warn', source: 'ReportBugDialog', message })
}

export function ReportBugDialog(): React.JSX.Element {
  const open = useReportBugOpen()
  const titleId = useId()
  const descriptionId = useId()

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [collectStatus, setCollectStatus] = useState<CollectStatus>('collecting')
  const [context, setContext] = useState<BugReportContext | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const collectRef = useRef<Promise<IpcResult<BugReportContext>> | null>(null)

  const busy = submitting || drafting

  // `disabled` freezes pick/paste/remove while a submit or draft is in flight
  // so a file staged after submit's attachments snapshot can't silently miss
  // the report.
  const { attachments, pickFiles, handlePaste, removeAttachment, clearAttachments, canPick } =
    useComposerAttachments({ imageCapable: true, embedCapable: false, disabled: busy })

  // Report screenshots are images only: drop anything non-image the OS
  // picker managed to stage (a text file arrives as a file-ref).
  useEffect(() => {
    const nonImage = attachments.find((a) => !isImageMime(a.mimeType))
    if (nonImage) removeAttachment(nonImage.id)
  }, [attachments, removeAttachment])

  // Reset + collect on every open. Collection runs once per open; the
  // promise is retained so submit/draft can await an in-flight collect.
  useEffect(() => {
    if (!open) return
    setTitle('')
    setDescription('')
    setFieldError(null)
    setContext(null)
    setCollectStatus('collecting')
    setPreviewOpen(false)
    clearAttachments()
    const pending = bugReportApi.collectBugReportContext()
    collectRef.current = pending
    let cancelled = false
    void pending.then((result) => {
      if (cancelled) return
      if (result.success) {
        setContext(result.data)
        setCollectStatus('ready')
      } else {
        // The facade already logged the transport failure; keep the dialog.
        setCollectStatus('unavailable')
      }
    })
    return () => {
      cancelled = true
    }
  }, [open, clearAttachments])

  /**
   * Resolve the diagnostics bundle for submit/draft: an already-collected
   * context, the still-in-flight collect promise, or the placeholder. Also
   * settles `collectStatus` so a slow collect raced by an early click still
   * leaves the UI honest.
   */
  const resolveContext = async (): Promise<BugReportContext> => {
    if (context) return context
    if (collectStatus === 'collecting' && collectRef.current) {
      const result = await collectRef.current
      if (result.success) {
        setContext(result.data)
        setCollectStatus('ready')
        return result.data
      }
      setCollectStatus('unavailable')
    }
    return DIAGNOSTICS_UNAVAILABLE
  }

  const effectiveContext = context ?? DIAGNOSTICS_UNAVAILABLE
  const markdown = useMemo(
    () =>
      collectStatus === 'collecting'
        ? null
        : buildIssueMarkdown(effectiveContext, title, description, attachments.length),
    [collectStatus, effectiveContext, title, description, attachments.length]
  )

  const close = useReportBugStore((s) => s.close)

  /**
   * One toast-safe line of `why`: the host's `reason` is bounded and already
   * redacted (static text or `gh` stderr), so surface it verbatim-ish —
   * flattened and truncated. A `transport` failure never reached `gh`, so its
   * copy names the IPC path instead of blaming the CLI.
   */
  const fallbackCause = (
    cause: 'unavailable' | 'failed' | 'transport',
    reason?: string
  ): string => {
    if (cause === 'transport') {
      return 'The report could not reach the host submit command (renderer transport failure).'
    }
    const flat = reason?.replace(/\s+/g, ' ').trim() ?? ''
    if (flat) return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
    return cause === 'failed' ? 'gh issue create failed.' : 'GitHub CLI is unavailable.'
  }

  const runFallback = async (
    ctx: BugReportContext,
    reportTitle: string,
    reportMarkdown: string,
    cause: 'unavailable' | 'failed' | 'transport',
    reason?: string
  ): Promise<void> => {
    logBoundary(`submit fell back to clipboard + prefilled issue (${cause})`)
    const outcome = await openBugReportFallback(ctx, reportTitle, reportMarkdown)
    const causeText = fallbackCause(cause, reason)
    if (outcome.copied && outcome.opened) {
      toast.info('Report copied — prefilled issue opened', {
        description: `${causeText} Paste the copied report into the issue in your browser.`
      })
    } else if (outcome.copied) {
      toast.info('Report copied to clipboard', {
        description: `${causeText} The browser could not be opened — paste the report into a new GitHub issue.`
      })
    } else {
      toast.error('Could not copy the report', {
        description: `${causeText} Select and copy the preview text, then paste it into a new GitHub issue.`
      })
    }
    // The dialog stays open: staged screenshots are still the user's way
    // into the issue (copy each image, paste it there).
  }

  const submit = async (): Promise<void> => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      setFieldError('Give the report a short title.')
      return
    }
    setSubmitting(true)
    setFieldError(null)
    try {
      const ctx = await resolveContext()
      const reportMarkdown = buildIssueMarkdown(ctx, title, description, attachments.length)
      const result = await bugReportApi.submitBugReport({
        title: trimmedTitle,
        body: reportMarkdown
      })
      if (!result.success) {
        // IPC/transport failure (the facade logged it) — same clipboard +
        // prefilled-URL path the user gets when `gh` is unavailable.
        await runFallback(ctx, trimmedTitle, reportMarkdown, 'transport')
        return
      }
      const outcome = result.data
      if (outcome.kind === 'submitted') {
        const issueUrl = outcome.issueUrl
        toast.success('Bug report filed', {
          description: 'The GitHub issue was created.',
          action: {
            label: 'Open issue',
            onClick: () => void openerApi.openUrlWithSystemBrowser(issueUrl)
          }
        })
        close()
        return
      }
      await runFallback(ctx, trimmedTitle, reportMarkdown, outcome.kind, outcome.reason)
    } catch (error) {
      // submitBugReport/collect resolve IpcResult and never throw; a throw
      // here is a renderer bug — log the boundary (no contents) and keep
      // the dialog open with the user's text intact.
      logBoundary(
        `submit threw unexpectedly: ${error instanceof Error ? error.message : String(error)}`
      )
      toast.error('Could not submit the report', {
        description: 'Copy the preview and file the issue manually on GitHub.'
      })
    } finally {
      setSubmitting(false)
    }
  }

  // "Draft with AI" — same gating as the commit composer: a selected,
  // configured ACP agent. Explicit click only; failures keep the user's text.
  const selectedAgentConfigId = useAcpStore((s) => s.selectedAgentConfigId)
  const agentConfigs = useAcpStore((s) => s.agentConfigs)
  const hasUsableAgent =
    selectedAgentConfigId !== null && agentConfigs.some((c) => c.id === selectedAgentConfigId)
  const activeProjectId = useActiveProjectId()

  const draft = async (): Promise<void> => {
    if (busy || !hasUsableAgent) return
    setDrafting(true)
    try {
      // Resolve the cwd at click time from store state — a render-time
      // `getDefaultCwdForProject` snapshot goes stale when the project list
      // hydrates after `activeProjectId` is set.
      const projectId = useProjectStore.getState().activeProjectId
      const cwd = projectId ? getDefaultCwdForProject(projectId) : ''
      if (!cwd) {
        toast.error('AI draft unavailable', {
          description: 'The project working directory is not known yet — your text was kept.'
        })
        return
      }
      const ctx = await resolveContext()
      const result = await useAcpStore.getState().draftBugReport({
        cwd,
        userDescription: description,
        diagnostics: ctx
      })
      if (!result) {
        // draftBugReport logs its own failure boundary; surface a toast and
        // keep whatever the user already typed.
        toast.error('AI draft unavailable', {
          description: 'The agent could not draft a report — your text was kept.'
        })
        return
      }
      setTitle(result.title)
      setDescription(result.body)
      setFieldError(null)
    } catch (error) {
      // draftBugReport resolves `null` and never throws; a throw here is a
      // renderer bug — log the boundary (no contents) and keep the user's text.
      logBoundary(
        `draft threw unexpectedly: ${error instanceof Error ? error.message : String(error)}`
      )
      toast.error('AI draft unavailable', {
        description: 'The agent could not draft a report — your text was kept.'
      })
    } finally {
      setDrafting(false)
    }
  }

  const [copiedId, setCopiedId] = useState<string | null>(null)
  const copyImage = async (att: PendingAttachment): Promise<void> => {
    try {
      await copyAttachmentImage(att)
      setCopiedId(att.id)
      // Brief check-mark feedback on the copied badge.
      setTimeout(() => setCopiedId((current) => (current === att.id ? null : current)), 2000)
      toast.success('Image copied — paste it into the GitHub issue')
    } catch {
      // copyAttachmentImage logged the boundary already.
      toast.error('Could not copy the image to the clipboard')
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) close()
      }}
    >
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bug size={16} className="text-muted-foreground" />
            Report a bug
          </DialogTitle>
          <DialogDescription>
            Describe what went wrong. The preview below is the exact markdown sent to GitHub —
            nothing is filed silently.
          </DialogDescription>
        </DialogHeader>

        <div
          className="grid min-h-0 flex-1 gap-3 overflow-y-auto py-2 pr-1"
          onPaste={(event) => handlePaste(event.nativeEvent)}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={titleId} className="text-xs">
              Title
            </Label>
            <Input
              id={titleId}
              value={title}
              placeholder="Short summary of the bug"
              autoFocus
              className="h-9"
              onChange={(event) => {
                setTitle(event.target.value)
                if (fieldError) setFieldError(null)
              }}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={descriptionId} className="text-xs">
              What happened?
            </Label>
            <Textarea
              id={descriptionId}
              value={description}
              placeholder="Steps to reproduce, what you expected, and what actually happened."
              rows={4}
              className="resize-y"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Screenshots</span>
              <AttachFilesButton onClick={() => void pickFiles()} disabled={!canPick} />
            </div>
            <p className="text-2xs text-muted-foreground">
              Screenshots stay on this device — nothing is uploaded. Copy each image and paste it
              into the GitHub issue.
            </p>
            <AttachmentPreviewGroup
              attachments={attachments}
              onRemove={removeAttachment}
              removeDisabled={busy}
              className="px-0 pt-0"
              attachmentActions={(att) =>
                isImageMime(att.mimeType) ? (
                  <button
                    type="button"
                    aria-label={`Copy ${att.name} to clipboard`}
                    title="Copy image — paste it into the GitHub issue"
                    onClick={(event) => {
                      event.stopPropagation()
                      void copyImage(att)
                    }}
                    className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {copiedId === att.id ? <Check size={11} /> : <Copy size={11} />}
                  </button>
                ) : null
              }
            />
          </div>

          <Collapsible open={previewOpen} onOpenChange={setPreviewOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-md border border-border bg-secondary/30 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
              >
                <span>Preview — the exact markdown sent to GitHub</span>
                <ChevronDown
                  size={14}
                  className={cn('transition-transform', previewOpen && 'rotate-180')}
                />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              {collectStatus === 'unavailable' && (
                <p className="mt-2 text-2xs text-warning">
                  Host diagnostics could not be collected — environment fields show as
                  "unavailable". The report still works.
                </p>
              )}
              <pre
                className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-secondary/30 p-2.5 font-mono text-2xs text-muted-foreground"
                data-testid="report-markdown-preview"
              >
                {markdown ?? 'Collecting diagnostics…'}
              </pre>
            </CollapsibleContent>
          </Collapsible>

          {fieldError && <p className="text-xs text-destructive">{fieldError}</p>}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div>
            {hasUsableAgent && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void draft()}
                disabled={busy || !activeProjectId}
                title={
                  activeProjectId
                    ? 'Draft the title and description with the selected agent'
                    : 'Open a project to draft with AI'
                }
              >
                {drafting ? (
                  <LoaderCircle size={13} className="mr-1.5 animate-spin" />
                ) : (
                  <Sparkles size={13} className="mr-1.5" />
                )}
                {drafting ? 'Drafting…' : 'Draft with AI'}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => close()} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void submit()}
              disabled={busy || collectStatus === 'collecting'}
              title={collectStatus === 'collecting' ? 'Collecting diagnostics…' : undefined}
            >
              {submitting ? 'Submitting…' : 'Submit report'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
