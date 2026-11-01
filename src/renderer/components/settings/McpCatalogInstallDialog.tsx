import { McpConsentDialog } from '@/components/settings/McpConsentDialog'
import { McpInstallForm } from '@/components/settings/McpInstallForm'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import {
  canStartOver,
  type McpCatalogInstall,
  type McpInstallFailure,
  type McpInstallProbe
} from '@/hooks/use-mcp-catalog-install'
import { mcpCatalogReasonText } from '@/lib/mcp-catalog-copy'
import { useAcpStore } from '@/stores/acp-store'

const HOST_FAILURE_TEXT: Record<string, string> = {
  MCP_PLAN_EXPIRED:
    'The review expired before it was approved, so nothing was saved. Start over to review it again.',
  MCP_PLAN_CONSUMED: 'This review was already used. Start over to install it again.',
  MCP_PLAN_NOT_FOUND:
    'Termul lost track of this install, for example after a reconnect. Start over to review it again.',
  MCP_PLAN_WRONG_CALLER:
    'This install was started from another connection. Start over to review it here.',
  MCP_PLAN_MISMATCH:
    'What would be saved no longer matches what you reviewed, so nothing was saved. Start over to review it again.',
  MCP_PLAN_LIMIT: 'Too many installs are waiting for approval. Close the others, then start over.',
  MCP_CATALOG_NOT_FOUND:
    'The catalog no longer lists this version. Search again to install the current one.',
  FORBIDDEN: "This connection can't make changes on the host, so it can't install servers."
}

function mcpInstallFailureText(failure: McpInstallFailure): string {
  switch (failure.kind) {
    case 'unsupported':
      return mcpCatalogReasonText(failure.reason)
    case 'save':
      return "Termul couldn't save the server after you approved it. Start over to try again."
    case 'host':
      return HOST_FAILURE_TEXT[failure.code] ?? "Termul couldn't install this server. Try again."
  }
}

function mcpInstallProbeText(probe: McpInstallProbe): string {
  switch (probe.status) {
    case 'connected':
      return `It responds and offers ${probe.tools} ${probe.tools === 1 ? 'tool' : 'tools'}.`
    case 'sign-in-required':
      return 'It needs you to sign in before agents can use it.'
    case 'disconnected':
      return probe.error
        ? `Termul couldn't reach it yet: ${probe.error}`
        : "Termul couldn't reach it yet. Check it in the MCP servers list."
  }
}

interface McpCatalogInstallDialogProps {
  install: McpCatalogInstall
  onEnableSync: (() => void) | null
}

export function McpCatalogInstallDialog({
  install,
  onEnableSync
}: McpCatalogInstallDialogProps): React.JSX.Element | null {
  const { flow, change, submit, approve, signIn, dismiss, startOver } = install

  switch (flow.step) {
    case 'idle':
      return null
    case 'consent':
    case 'committing':
      return (
        <McpConsentDialog
          open
          plan={flow.plan}
          busy={flow.step === 'committing'}
          onApprove={approve}
          onCancel={dismiss}
          notice={
            onEnableSync && (
              <SettingsNotice
                action={
                  <Button type="button" size="xs" variant="outline" onClick={onEnableSync}>
                    Turn on sync
                  </Button>
                }
              >
                Catalog sync is off, so this listing may be out of date.
              </SettingsNotice>
            )
          }
        />
      )
    case 'form':
    case 'planning': {
      const planning = flow.step === 'planning'
      return (
        <StepDialog title={`Install ${flow.target.title}`} onClose={dismiss}>
          <DialogDescription>
            Fill in what this server needs. Next, you review exactly what will run.
          </DialogDescription>
          <form
            id="mcp-install-form"
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <McpInstallForm
              fields={flow.form.fields}
              values={flow.values}
              onChange={change}
              disabled={planning}
              errors={flow.step === 'form' ? flow.fieldErrors : {}}
            />
            {flow.step === 'form' && flow.error !== null && (
              <SettingsNotice tone="danger" role="alert">
                {flow.error}
              </SettingsNotice>
            )}
          </form>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={dismiss}>
              Cancel
            </Button>
            <Button type="submit" form="mcp-install-form" size="sm" disabled={planning}>
              {planning ? 'Checking…' : 'Review'}
            </Button>
          </DialogFooter>
        </StepDialog>
      )
    }
    case 'describing':
      return (
        <StepDialog title={`Install ${flow.target.title}`} onClose={dismiss}>
          <DialogDescription className="flex items-center gap-2 text-xs">
            <Spinner size={13} decorative />
            Loading what this server needs…
          </DialogDescription>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={dismiss}>
              Cancel
            </Button>
          </DialogFooter>
        </StepDialog>
      )
    case 'probing':
    case 'done':
      return (
        <StepDialog title={`Installed ${flow.server.name}`} onClose={dismiss}>
          <DialogDescription>It's in your MCP servers list, turned on.</DialogDescription>
          {flow.step === 'probing' ? (
            <Pending>Checking that it responds…</Pending>
          ) : flow.probe.status === 'sign-in-required' ? (
            <SignInNotice serverId={flow.server.id} onSignIn={signIn} />
          ) : (
            <SettingsNotice tone={flow.probe.status === 'connected' ? 'success' : 'warning'}>
              {mcpInstallProbeText(flow.probe)}
            </SettingsNotice>
          )}
          <DialogFooter>
            <Button type="button" size="sm" onClick={dismiss}>
              Done
            </Button>
          </DialogFooter>
        </StepDialog>
      )
    case 'failed':
      return (
        <StepDialog title={`Couldn't install ${flow.target.title}`} onClose={dismiss}>
          <DialogDescription>Nothing was saved.</DialogDescription>
          <SettingsNotice tone="danger" role="alert">
            {mcpInstallFailureText(flow.failure)}
          </SettingsNotice>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={dismiss}>
              Close
            </Button>
            {canStartOver(flow.failure) && (
              <Button type="button" size="sm" onClick={startOver}>
                Start over
              </Button>
            )}
          </DialogFooter>
        </StepDialog>
      )
  }
}

function SignInNotice({
  serverId,
  onSignIn
}: {
  serverId: string
  onSignIn: () => void
}): React.JSX.Element {
  const connecting = useAcpStore((state) => state.mcpOAuthConnecting[serverId] === true)
  const connected = useAcpStore((state) => state.mcpOAuthConnected[serverId] === true)
  if (connected) return <SettingsNotice tone="success">Signed in.</SettingsNotice>
  return (
    <SettingsNotice
      tone="info"
      action={
        <Button type="button" size="xs" variant="outline" disabled={connecting} onClick={onSignIn}>
          {connecting ? 'Signing in…' : 'Sign in'}
        </Button>
      }
    >
      {connecting
        ? 'Finish signing in in the browser window that opened.'
        : mcpInstallProbeText({ status: 'sign-in-required' })}
    </SettingsNotice>
  )
}

function StepDialog({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

function Pending({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Spinner size={13} decorative />
      {children}
    </p>
  )
}
