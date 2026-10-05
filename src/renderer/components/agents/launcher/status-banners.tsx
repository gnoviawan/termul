import type { Dispatch, SetStateAction } from 'react'
import { Button } from '@/components/ui/button'
import type { AuthMethod } from '@/lib/acp-api'
import { agentPolicy } from '@/lib/agents/acp-registry'
import type { PrepareChatError } from '@/lib/agents/acp-spawn-errors'
import type {
  SupportedAcpAgentEntry,
  SupportedAcpAgentInstall,
  SupportedAcpAgentManagedInstall,
  SupportedAcpAgentManualInstall
} from '@/lib/agents/supported-acp-agents'
import {
  AuthRequiredBanner,
  InstallRequiredBanner,
  ManualInstallBanner,
  NeedsRuntimeBanner,
  NonAuthFailureBanner
} from './banners'
import { FactoryApiKeyForm, type FactoryKeyAuth } from './FactoryApiKeyForm'

/**
 * The composer card's in-flow status section: whichever of install-required /
 * manual-install / needs-runtime / unavailable / auth-required / Factory key
 * form / non-auth-failure applies to the selected agent right now (all are
 * mutually exclusive by `selectedEntry.status` + `prepareError.category`).
 */
export function LauncherStatusBanners({
  selectedEntry,
  manualInstallContext,
  installingConfigId,
  handleInstallAgent,
  selectedInstall,
  setManualInstallOverride,
  manualPath,
  savingManualPath,
  setManualPath,
  handleBrowseManualPath,
  handleSaveManualPath,
  prepareError,
  authMethods,
  signingInMethodId,
  handleAuthMethod,
  handleGatewayAuth,
  onSignOut,
  handleRetryPrepare,
  factoryKeyAuth,
  inlineKeyMethodId
}: {
  selectedEntry: SupportedAcpAgentEntry | null
  manualInstallContext: SupportedAcpAgentManualInstall | null
  installingConfigId: string | null
  handleInstallAgent: (entry: SupportedAcpAgentEntry) => Promise<void>
  selectedInstall: SupportedAcpAgentInstall | SupportedAcpAgentManagedInstall | null
  setManualInstallOverride: Dispatch<SetStateAction<SupportedAcpAgentManualInstall | null>>
  manualPath: string
  savingManualPath: boolean
  setManualPath: Dispatch<SetStateAction<string>>
  handleBrowseManualPath: () => Promise<void>
  handleSaveManualPath: (
    entry: SupportedAcpAgentEntry,
    manual: SupportedAcpAgentManualInstall
  ) => Promise<void>
  prepareError: PrepareChatError | null
  authMethods: AuthMethod[]
  signingInMethodId: string | null
  handleAuthMethod: (method: AuthMethod) => void
  handleGatewayAuth: (method: AuthMethod, gateway: { baseUrl: string; apiKey?: string }) => void
  onSignOut: (() => void) | null
  handleRetryPrepare: () => void
  factoryKeyAuth: FactoryKeyAuth
  inlineKeyMethodId: string | undefined
}): React.JSX.Element {
  return (
    <>
      {onSignOut ? (
        <div className="flex justify-end border-b border-border/60 px-5 py-2">
          <Button type="button" size="sm" variant="outline" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      ) : null}
      {selectedEntry?.status === 'install-required' && !manualInstallContext && (
        <InstallRequiredBanner
          entry={selectedEntry}
          installing={installingConfigId === selectedEntry.configId}
          onInstall={() => void handleInstallAgent(selectedEntry)}
          onUseCustomPath={
            selectedInstall?.kind === 'archive'
              ? () =>
                  setManualInstallOverride({
                    cmd: selectedInstall.cmd,
                    args: selectedInstall.args,
                    env: selectedInstall.env
                  })
              : undefined
          }
        />
      )}
      {manualInstallContext && selectedEntry && (
        <ManualInstallBanner
          entry={selectedEntry}
          manual={manualInstallContext}
          path={manualPath}
          saving={savingManualPath}
          onPathChange={setManualPath}
          onBrowse={() => void handleBrowseManualPath()}
          onSave={() => void handleSaveManualPath(selectedEntry, manualInstallContext)}
        />
      )}
      {selectedEntry?.status === 'needs-runtime' && <NeedsRuntimeBanner entry={selectedEntry} />}
      {selectedEntry?.status === 'unavailable' && (
        <div className="border-b border-border/60 px-5 py-3 text-xs text-muted-foreground">
          {selectedEntry.unavailableReason ?? 'This ACP agent is not available on this platform.'}
        </div>
      )}
      {selectedEntry?.status === 'manual-install' &&
        !manualInstallContext &&
        agentPolicy(selectedEntry.id).install.kind === 'managed-npm' && (
          <div className="border-b border-border/60 px-5 py-3 text-xs text-muted-foreground">
            {selectedEntry.unavailableReason}
          </div>
        )}
      {prepareError &&
        (prepareError.category === 'auth' || prepareError.category === 'multi-auth') && (
          <AuthRequiredBanner
            agentName={selectedEntry?.agent.name ?? 'Agent'}
            setupError={prepareError}
            authMethods={authMethods}
            signingInMethodId={signingInMethodId}
            onAuthenticate={handleAuthMethod}
            onGatewayAuth={handleGatewayAuth}
            onRetry={handleRetryPrepare}
          />
        )}
      {factoryKeyAuth.showKeyInput && inlineKeyMethodId ? (
        <FactoryApiKeyForm auth={factoryKeyAuth} />
      ) : null}
      {/* Story 11 (QA F12/F9): non-auth prepare failures (spawn /
        transport / timeout) previously surfaced only as a "Setup
        failed" pill with Retry buried inside the model-picker modal.
        Render them in-flow above the composer — same pattern as
        AuthRequiredBanner — with a Retry that re-runs prepare. */}
      {prepareError &&
        (prepareError.category === 'spawn' ||
          prepareError.category === 'transport' ||
          prepareError.category === 'timeout') && (
          <NonAuthFailureBanner
            agentName={selectedEntry?.agent.name ?? 'Agent'}
            setupError={prepareError}
            onRetry={handleRetryPrepare}
          />
        )}
    </>
  )
}
