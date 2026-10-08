import { useState } from 'react'
import { Download, FolderOpen } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import type { AuthMethod } from '@/lib/acp-api'
import type { PrepareChatError } from '@/lib/agents/acp-spawn-errors'
import type {
  SupportedAcpAgentEntry,
  SupportedAcpAgentManualInstall
} from '@/lib/agents/supported-acp-agents'
import { openerApi } from '@/lib/api'

const RUNTIME_HELP_URLS = {
  npx: 'https://nodejs.org/en/download',
  uvx: 'https://docs.astral.sh/uv/getting-started/installation/'
} as const

/** Zed-style auth callout: visible without opening the model picker popover. */
export function AuthRequiredBanner({
  agentName,
  setupError,
  authMethods,
  signingInMethodId,
  onAuthenticate,
  onGatewayAuth,
  onRetry
}: {
  agentName: string
  setupError: PrepareChatError
  authMethods: AuthMethod[]
  signingInMethodId: string | null
  onAuthenticate: (method: AuthMethod) => void
  onGatewayAuth: (method: AuthMethod, gateway: { baseUrl: string; apiKey?: string }) => void
  onRetry: () => void
}): React.JSX.Element {
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [gatewayKey, setGatewayKey] = useState('')
  const signingInMethod = authMethods.find((m) => m.id === signingInMethodId)
  const actionableMethods = authMethods.filter((m) => m.id.trim().length > 0)
  // Only 'agent' (and untyped — the pre-extension wire) and 'terminal'
  // methods can be driven from here. 'env_var'/'unknown'/future variants are
  // advertised for completeness but render disabled with guidance text.
  const runnableMethods = actionableMethods.filter(
    (m) => m.id !== 'gateway' && (m.type === 'agent' || m.type === 'terminal' || m.type == null)
  )
  const gatewayMethod = actionableMethods.find((m) => m.id === 'gateway')
  const guidanceMethods = actionableMethods.filter(
    (m) => !(m.type === 'agent' || m.type === 'terminal' || m.type == null)
  )

  return (
    <div className="border-b border-border/60 px-5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground">
            {signingInMethod ? `Authenticating to ${agentName}…` : `Authenticate to ${agentName}`}
          </div>
          <p className="mt-0.5 line-clamp-4 break-words text-xs text-muted-foreground">
            {setupError.detail}
          </p>
          {setupError.category === 'multi-auth' && actionableMethods.length > 1 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Choose one of the following authentication options:
            </p>
          ) : null}
          {guidanceMethods.map((method) => {
            // env_var (and any future variant) is advertised for completeness
            // but cannot be driven from here — show the method's own
            // description as guidance when the agent provided one.
            const hint = method.description?.trim()
            if (!hint) return null
            return (
              <p key={method.id} className="mt-1 break-words text-xs text-muted-foreground">
                {hint}
              </p>
            )
          })}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {signingInMethod ? (
            <Button type="button" size="sm" disabled>
              <Spinner size={14} decorative className="mr-1.5" />
              {`Signing in with ${signingInMethod.name}…`}
            </Button>
          ) : (
            <>
              {gatewayMethod ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={gatewayUrl}
                    onChange={(event) => setGatewayUrl(event.target.value)}
                    placeholder="Gateway base URL"
                    aria-label="Gateway base URL"
                    className="h-8 w-48"
                  />
                  <Input
                    value={gatewayKey}
                    onChange={(event) => setGatewayKey(event.target.value)}
                    placeholder="API key (optional)"
                    aria-label="Gateway API key"
                    type="password"
                    className="h-8 w-40"
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={!gatewayUrl.trim()}
                    onClick={() =>
                      onGatewayAuth(gatewayMethod, {
                        baseUrl: gatewayUrl.trim(),
                        ...(gatewayKey.trim() ? { apiKey: gatewayKey.trim() } : {})
                      })
                    }
                  >
                    {gatewayMethod.name}
                  </Button>
                </div>
              ) : null}
              {runnableMethods.map((method, index) => (
                <Button
                  key={method.id}
                  type="button"
                  size="sm"
                  variant={index === runnableMethods.length - 1 ? 'default' : 'outline'}
                  title={method.description ?? undefined}
                  onClick={() => onAuthenticate(method)}
                >
                  {method.name}
                </Button>
              ))}
              {guidanceMethods.map((method) => (
                <Button
                  key={method.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled
                  title={`${method.name} is not supported yet`}
                >
                  {`${method.name} (not supported)`}
                </Button>
              ))}
              {/* Always offer Retry — when every advertised method is
                  non-runnable (env_var/unknown) it is the only way forward. */}
              {runnableMethods.length === 0 ? (
                <Button type="button" size="sm" variant="outline" onClick={onRetry}>
                  Retry
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Story 11 (QA F12): in-flow banner for non-auth prepare failures — spawn /
 * transport / timeout. Previously these surfaced only as a "Setup failed"
 * model pill whose Retry was buried inside the model-picker modal; auth
 * failures already had an in-flow banner (AuthRequiredBanner). Same layout
 * chrome as AuthRequiredBanner so the two read as one family: label + detail
 * on the left, a Retry button on the right.
 */
export function NonAuthFailureBanner({
  agentName,
  setupError,
  onRetry
}: {
  agentName: string
  setupError: PrepareChatError
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="border-b border-border/60 px-5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground">
            {`${agentName}: ${setupError.label}`}
          </div>
          <p className="mt-0.5 line-clamp-4 break-words text-xs text-muted-foreground">
            {setupError.detail}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </div>
    </div>
  )
}

export function InstallRequiredBanner({
  entry,
  installing,
  onInstall,
  onUseCustomPath
}: {
  entry: SupportedAcpAgentEntry
  installing: boolean
  onInstall: () => void
  onUseCustomPath?: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">Install required</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {entry.install?.kind === 'managed-npm'
            ? `Termul will install the pinned ${entry.install.package} package in its host cache.`
            : `${entry.agent.name} needs a local ACP binary before it can start chats.`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onUseCustomPath && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={installing}
            onClick={onUseCustomPath}
          >
            Custom path
          </Button>
        )}
        <Button type="button" size="sm" disabled={installing} onClick={onInstall}>
          {installing ? (
            <Spinner size={14} decorative className="mr-1.5" />
          ) : (
            <Download size={14} className="mr-1.5" />
          )}
          {installing ? 'Installing…' : 'Install'}
        </Button>
      </div>
    </div>
  )
}

export function NeedsRuntimeBanner({
  entry
}: {
  entry: SupportedAcpAgentEntry
}): React.JSX.Element {
  const launcher = entry.runtimeLauncher ?? 'npx'
  const helpUrl = RUNTIME_HELP_URLS[launcher]
  const helpLabel = launcher === 'uvx' ? 'Install uv' : 'Install Node.js'

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">Runtime required</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{entry.unavailableReason}</p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void openerApi.openUrlWithSystemBrowser(helpUrl)}
      >
        {helpLabel}
      </Button>
    </div>
  )
}

export function ManualInstallBanner({
  entry,
  manual,
  path,
  saving,
  onPathChange,
  onBrowse,
  onSave
}: {
  entry: SupportedAcpAgentEntry
  manual: SupportedAcpAgentManualInstall
  path: string
  saving: boolean
  onPathChange: (value: string) => void
  onBrowse: () => void
  onSave: () => void
}): React.JSX.Element {
  const expectedCommand = `${manual.cmd}${manual.args.length > 0 ? ` ${manual.args.join(' ')}` : ''}`

  return (
    <div className="space-y-3 border-b border-border/60 px-5 py-3">
      <div>
        <div className="text-xs font-medium text-foreground">Manual install</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {entry.unavailableReason ??
            `Install ${entry.agent.name} from the vendor, then point Termul at the binary.`}
        </p>
        {expectedCommand && (
          <p className="mt-1 font-mono text-2xs text-muted-foreground">
            Expected: {expectedCommand}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={path}
          onChange={(event) => onPathChange(event.target.value)}
          placeholder="Path to installed ACP binary"
          aria-label="ACP agent executable path"
          className="h-8 font-mono text-xs"
          disabled={saving}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={onBrowse}
          aria-label="Browse for ACP agent executable"
        >
          <FolderOpen size={14} />
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={saving || path.trim().length === 0}
          onClick={onSave}
        >
          {saving ? <Spinner size={14} decorative /> : 'Save'}
        </Button>
      </div>
    </div>
  )
}
