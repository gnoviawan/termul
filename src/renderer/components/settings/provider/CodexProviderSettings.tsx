import type { CodexAccountView } from '@shared/types/codex-accounts.types'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Info, KeyRound, Monitor, Plus, RotateCcw, WifiOff } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useCodexAccounts } from '@/hooks/use-codex-accounts'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { codexAccountsApi } from '@/lib/codex-accounts-api'
import { getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import { READ_ONLY_SERVER_REASON } from '@/lib/write-gate'
import { applyProjectCodexAccount } from '@/stores/codex-account-switch'
import { useProjectStore } from '@/stores/project-store'
import type { ProjectColor } from '@/types/project'
import { SettingsCard } from '../SettingsGroup'
import { SettingsRow, settingsDescriptionId } from '../SettingsRow'
import { AccountNameDialog } from './AccountNameDialog'
import { toastAccountChoiceError } from './account-choice-error'
import { AccountAvatar, DefaultPill } from './ClaudeAccountRow'
import { CodexAccountActions } from './CodexAccountActions'
import { CodexAddAccountDialog } from './CodexAddAccountDialog'
import { CodexSignInDialog } from './CodexSignInDialog'
import { CodexUsageMeters } from './CodexUsageMeters'
import { CODEX_NOT_READY_REASON, codexAccountReadiness } from './codex-account-status'
import { ProviderGroupHeader } from './ProviderGroupHeader'

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Settings → Provider: the Codex Accounts of this host. A connection that can
 * make changes can add, rename and remove an Account and sign it in with
 * ChatGPT. The automatic-switching control only stores the flag.
 */
export function CodexProviderSettings(): React.JSX.Element {
  const { snapshot, usage, loading, error, reload, refreshUsage, refreshingUsage } =
    useCodexAccounts({
      usage: true
    })
  const canManage = useServerAdmitsRemoteWrites()
  const projects = useProjectStore((s) => s.projects)
  const [addOpen, setAddOpen] = useState(false)
  const [renaming, setRenaming] = useState<CodexAccountView | null>(null)
  const [removing, setRemoving] = useState<CodexAccountView | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [signingIn, setSigningIn] = useState<CodexAccountView | null>(null)
  const [savingAutoSwitch, setSavingAutoSwitch] = useState(false)

  const projectsByAccount = useMemo(() => {
    const byAccount: Record<string, { id: string; name: string; color: ProjectColor }[]> = {}
    for (const [projectId, accountId] of Object.entries(snapshot?.projectAccounts ?? {})) {
      const project = projects.find((p) => p.id === projectId)
      if (!project) continue
      byAccount[accountId] ??= []
      byAccount[accountId].push({ id: project.id, name: project.name, color: project.color })
    }
    return byAccount
  }, [snapshot, projects])

  const accounts = snapshot?.accounts ?? []
  const defaultAccount = accounts.find((a) => a.id === snapshot?.defaultAccountId) ?? null
  const failed = !loading && (error !== null || !snapshot)

  const makeDefault = async (account: CodexAccountView): Promise<void> => {
    try {
      await codexAccountsApi.setDefault(account.id)
      await reload()
      toast.success(`${account.name} is now the default account`)
    } catch (err) {
      toastAccountChoiceError(err, 'Could not change the default account')
      await reload()
    }
  }

  const setAutoSwitch = async (enabled: boolean): Promise<void> => {
    setSavingAutoSwitch(true)
    try {
      await codexAccountsApi.setAutoSwitch(enabled)
    } catch (err) {
      toast.error(`Could not change automatic switching: ${errorText(err)}`)
    } finally {
      await reload()
      setSavingAutoSwitch(false)
    }
  }

  const confirmRemove = async (): Promise<void> => {
    if (!removing || !snapshot) return
    const account = removing
    const followers =
      account.id === snapshot.defaultAccountId
        ? projects.filter((p) => !(p.id in snapshot.projectAccounts)).map((p) => p.id)
        : []
    setRemoveBusy(true)
    try {
      const moved = await codexAccountsApi.remove(account.id)
      for (const projectId of new Set([...moved, ...followers])) {
        void applyProjectCodexAccount(projectId)
      }
      setRemoving(null)
      await reload()
      toast.success(`${account.name} was removed`)
    } catch (err) {
      toast.error(`Could not remove ${account.name}: ${errorText(err)}`)
    } finally {
      setRemoveBusy(false)
    }
  }

  const removingProjects = removing ? (projectsByAccount[removing.id] ?? []) : []

  return (
    <div className="mt-8 flex flex-col gap-1" data-testid="codex-provider-settings">
      <ProviderGroupHeader
        iconKey="acp:codex-acp"
        name="Codex"
        count={
          snapshot && !failed
            ? accounts.length === 1
              ? '1 account'
              : `${accounts.length} accounts`
            : undefined
        }
        lastChecked={null}
        refreshing={refreshingUsage}
        action={
          canManage &&
          !failed && (
            <Button type="button" size="xs" variant="outline" onClick={() => setAddOpen(true)}>
              <Plus />
              Add account
            </Button>
          )
        }
      />

      {loading && (
        <div className="py-4 text-xs text-muted-foreground" aria-busy="true">
          Loading Codex accounts…
        </div>
      )}

      {failed && (
        <div className="flex items-center gap-3 py-4">
          <WifiOff size={16} className="shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-xs font-medium text-foreground">
              Codex accounts are not available right now
            </span>
            <span className="text-2xs text-muted-foreground">
              {error ? `${error}. ` : ''}Chats keep using the account they started with.
            </span>
          </div>
          <Button type="button" size="xs" variant="outline" onClick={() => void reload()}>
            <RotateCcw />
            Try again
          </Button>
        </div>
      )}

      {!loading && !failed && snapshot && (
        <div>
          {accounts.map((account) => {
            const read = usage[account.id]
            const readiness = codexAccountReadiness(account, read)
            const projectNames = (projectsByAccount[account.id] ?? []).map((p) => p.name)
            const windows = read?.status === 'ok' ? read.windows : []
            return (
              <div
                key={account.id}
                data-testid={`codex-account-${account.id}`}
                className="flex items-start gap-3 border-b border-border/60 py-3 last:border-b-0"
              >
                <AccountAvatar name={account.name} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground">
                    <span className="truncate">{account.name}</span>
                    {account.id === snapshot.defaultAccountId && <DefaultPill />}
                  </span>
                  <span className="truncate text-2xs text-muted-foreground">
                    {projectNames.length > 0
                      ? `${readiness === 'ready' ? 'Signed in' : CODEX_NOT_READY_REASON[readiness]} · ${projectNames.join(', ')}`
                      : readiness === 'ready'
                        ? 'Signed in'
                        : CODEX_NOT_READY_REASON[readiness]}
                  </span>
                  <CodexUsageMeters windows={windows} />
                </div>
                {canManage && (
                  <CodexAccountActions
                    accountName={account.name}
                    builtin={account.builtin}
                    isDefault={account.id === snapshot.defaultAccountId}
                    signedOut={readiness === 'signed-out'}
                    ready={readiness === 'ready'}
                    canManage={canManage}
                    busy={signingIn?.id === account.id}
                    onSignIn={() => setSigningIn(account)}
                    onMakeDefault={() => void makeDefault(account)}
                    onRename={() => setRenaming(account)}
                    onRemove={() => setRemoving(account)}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {!loading && !failed && snapshot && (
        <SettingsCard className="mt-3">
          <SettingsRow
            htmlFor="codex-auto-switch"
            label="Switch accounts automatically"
            description="When a chat reaches its account's limit, continue it on the signed-in account with the most room."
            layout="inline"
          >
            <Switch
              id="codex-auto-switch"
              aria-describedby={settingsDescriptionId('codex-auto-switch')}
              checked={snapshot.autoSwitch}
              disabled={savingAutoSwitch || !canManage}
              onCheckedChange={(enabled) => void setAutoSwitch(enabled)}
            />
          </SettingsRow>
        </SettingsCard>
      )}

      {!loading && !failed && canManage && accounts.length === 1 && (
        <div className="mt-2 flex items-center gap-3 rounded-lg border border-border/60 bg-foreground/[0.02] p-3.5">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-secondary-foreground"
          >
            <KeyRound size={14} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-xs font-medium text-foreground">
              Keep work and personal apart
            </span>
            <span className="text-2xs leading-relaxed text-muted-foreground">
              Add another Codex account and choose it per project. Each one is a ChatGPT login.
            </span>
          </div>
        </div>
      )}

      {!loading && !failed && (
        <p className="flex flex-wrap items-center gap-1.5 pt-2 text-2xs text-muted-foreground">
          {canManage ? (
            <>
              <Info size={12} className="shrink-0" />
              Choose an account per project in Project settings → Accounts.
            </>
          ) : (
            <>
              <Monitor size={12} className="shrink-0" />
              {READ_ONLY_SERVER_REASON} To add or sign in to an account, use the desktop app, or run
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-secondary-foreground">
                troupe-server codex account
              </code>
              on the host.
            </>
          )}
        </p>
      )}

      {canManage && (
        <>
          <CodexAddAccountDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            onAdded={async (created) => {
              await reload()
              toast.success(`${created.name} was added`)
              setSigningIn({
                id: created.id,
                name: created.name,
                builtin: false,
                signedIn: false
              })
            }}
          />
          <CodexSignInDialog
            account={signingIn}
            onClose={() => setSigningIn(null)}
            onSignedIn={async (account) => {
              setSigningIn(null)
              await reload()
              await refreshUsage(true)
              toast.success(`${account.name} is signed in`)
            }}
          />
          <AccountNameDialog
            open={renaming !== null}
            initialName={renaming?.name ?? ''}
            onOpenChange={(open) => !open && setRenaming(null)}
            onSubmit={async (name) => {
              if (!renaming) return
              await codexAccountsApi.rename(renaming.id, name)
              await reload()
            }}
          />
        </>
      )}

      <ConfirmDialog
        isOpen={removing !== null}
        title={removing ? `Remove ${removing.name}?` : 'Remove account?'}
        message="Codex signs out of this account on this computer. Its chat history stays."
        confirmLabel="Remove"
        variant="danger"
        isLoading={removeBusy}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setRemoving(null)}
      >
        {removingProjects.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3">
            <span className="text-2xs font-medium text-secondary-foreground">
              {removingProjects.length === 1
                ? '1 project moves'
                : `${removingProjects.length} projects move`}{' '}
              to the default account
              {defaultAccount && defaultAccount.id !== removing?.id
                ? ` (${defaultAccount.name})`
                : ''}
            </span>
            {removingProjects.map((project) => (
              <span
                key={project.id}
                className="flex items-center gap-2 text-2xs text-muted-foreground"
              >
                <span
                  aria-hidden="true"
                  className={cn('size-2 rounded-sm', getColorClasses(project.color).bg)}
                />
                {project.name}
              </span>
            ))}
          </div>
        )}
      </ConfirmDialog>
    </div>
  )
}
