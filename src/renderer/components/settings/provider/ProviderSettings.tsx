import type { ClaudeAccountView } from '@shared/types/claude-accounts.types'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Info, KeyRound, Monitor, Plus, RotateCcw, WifiOff } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { useClaudeAccounts } from '@/hooks/use-claude-accounts'
import { claudeAccountsApi, isClaudeLoginCancelled } from '@/lib/claude-accounts-api'
import { getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import type { ProjectColor } from '@/types/project'
import { AccountNameDialog } from './AccountNameDialog'
import { AddAccountDialog } from './AddAccountDialog'
import { ClaudeAccountActions } from './ClaudeAccountActions'
import { ClaudeAccountRow, isAccountSignedOut } from './ClaudeAccountRow'
import { oldestCheck, ProviderGroupHeader } from './ProviderGroupHeader'

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

function SkeletonRow(): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-4 border-b border-border/60 py-3.5 last:border-b-0"
      aria-hidden="true"
    >
      <span className="size-7 rounded-full bg-muted" />
      <span className="flex w-40 flex-col gap-1.5">
        <span className="h-2 w-20 rounded bg-muted" />
        <span className="h-1.5 w-28 rounded bg-muted" />
      </span>
      <span className="flex flex-1 flex-col gap-2">
        <span className="h-2 w-2/5 rounded bg-muted" />
        <span className="h-1 w-full rounded-full bg-muted" />
      </span>
    </div>
  )
}

/**
 * Settings → Provider: the Claude Accounts of this host as flat rows, with
 * each Account's main usage meter. Desktop can add, sign in, rename and remove
 * Accounts; the web client can view them and choose the default.
 */
export function ProviderSettings(): React.JSX.Element {
  const { snapshot, usage, loading, error, refreshingUsage, reload, refreshUsage } =
    useClaudeAccounts()
  const canManage = claudeAccountsApi.canManageAccounts()
  const projects = useProjectStore((s) => s.projects)
  const [addOpen, setAddOpen] = useState(false)
  const [renaming, setRenaming] = useState<ClaudeAccountView | null>(null)
  const [removing, setRemoving] = useState<ClaudeAccountView | null>(null)
  const [removeBusy, setRemoveBusy] = useState(false)
  const [signingInId, setSigningInId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

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

  const signIn = async (account: ClaudeAccountView): Promise<void> => {
    setSigningInId(account.id)
    try {
      await claudeAccountsApi.login(account.id)
      toast.success(`${account.name} is signed in`)
      await reload()
      await refreshUsage(true)
    } catch (err) {
      if (!isClaudeLoginCancelled(err)) toast.error(`Sign-in did not finish: ${errorText(err)}`)
    } finally {
      setSigningInId(null)
    }
  }

  const makeDefault = async (account: ClaudeAccountView): Promise<void> => {
    try {
      await claudeAccountsApi.setDefault(account.id)
      await reload()
      toast.success(`${account.name} is now the default account`)
    } catch (err) {
      toast.error(`Could not change the default account: ${errorText(err)}`)
    }
  }

  const confirmRemove = async (): Promise<void> => {
    if (!removing) return
    const account = removing
    setRemoveBusy(true)
    try {
      await claudeAccountsApi.remove(account.id)
      setRemoving(null)
      await reload()
      toast.success(`${account.name} was removed`)
    } catch (err) {
      toast.error(`Could not remove ${account.name}: ${errorText(err)}`)
    } finally {
      setRemoveBusy(false)
    }
  }

  const accounts = snapshot?.accounts ?? []
  const defaultAccount = accounts.find((a) => a.id === snapshot?.defaultAccountId) ?? null
  const failed = !loading && (error !== null || !snapshot)
  const addButton = canManage && !failed && (
    <Button type="button" size="xs" variant="outline" onClick={() => setAddOpen(true)}>
      <Plus />
      Add account
    </Button>
  )
  const removingProjects = removing ? (projectsByAccount[removing.id] ?? []) : []

  return (
    <div className="flex flex-col gap-1">
      <ProviderGroupHeader
        iconKey="acp:claude-acp"
        name="Claude Code"
        count={
          snapshot && !failed
            ? accounts.length === 1
              ? '1 account'
              : `${accounts.length} accounts`
            : undefined
        }
        lastChecked={failed ? null : oldestCheck(usage)}
        refreshing={refreshingUsage}
        onRefresh={failed ? undefined : () => void refreshUsage(true)}
        action={addButton}
      />

      {loading && (
        <div>
          <SkeletonRow />
          <SkeletonRow />
        </div>
      )}

      {failed && (
        <div className="flex items-center gap-3 py-4">
          <WifiOff size={16} className="shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-xs font-medium text-foreground">
              Claude accounts are not available right now
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
          {accounts.map((account) => (
            <ClaudeAccountRow
              key={account.id}
              account={account}
              usage={usage[account.id]}
              isDefault={account.id === snapshot.defaultAccountId}
              projectNames={(projectsByAccount[account.id] ?? []).map((p) => p.name)}
              signingIn={signingInId === account.id}
              expanded={Boolean(expanded[account.id])}
              canManage={canManage}
              onToggle={() => setExpanded((s) => ({ ...s, [account.id]: !s[account.id] }))}
              onSignIn={() => void signIn(account)}
              onCancelSignIn={() => void claudeAccountsApi.cancelLogin(account.id)}
              onRetryUsage={() => void refreshUsage(true)}
              menu={
                <ClaudeAccountActions
                  accountName={account.name}
                  builtin={account.builtin}
                  isDefault={account.id === snapshot.defaultAccountId}
                  signedOut={isAccountSignedOut(account, usage[account.id])}
                  canManage={canManage}
                  busy={signingInId === account.id}
                  onSignIn={() => void signIn(account)}
                  onMakeDefault={() => void makeDefault(account)}
                  onRename={() => setRenaming(account)}
                  onRemove={() => setRemoving(account)}
                />
              }
            />
          ))}
        </div>
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
              Add another Claude account and choose it per project. When one hits its limit, Termul
              can offer to switch.
            </span>
          </div>
          <Button type="button" size="xs" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus />
            Add account
          </Button>
        </div>
      )}

      {!loading && !failed && (
        <p className="flex flex-wrap items-center gap-1.5 pt-2 text-2xs text-muted-foreground">
          {canManage ? (
            <>
              <Info size={12} className="shrink-0" />
              Choose an account per project in Project Settings → Provider.
            </>
          ) : (
            <>
              <Monitor size={12} className="shrink-0" />
              To add or sign in to an account, use the desktop app, or run
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-3xs text-secondary-foreground">
                termul-server claude account
              </code>
              on the host.
            </>
          )}
        </p>
      )}

      {canManage && (
        <>
          <AddAccountDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            existingNames={accounts.map((a) => a.name)}
            defaultAccountName={defaultAccount?.name ?? null}
            usage={usage}
            onChanged={reload}
            onSignedIn={() => refreshUsage(true)}
          />
          <AccountNameDialog
            open={renaming !== null}
            initialName={renaming?.name ?? ''}
            onOpenChange={(open) => !open && setRenaming(null)}
            onSubmit={async (name) => {
              if (!renaming) return
              await claudeAccountsApi.rename(renaming.id, name)
              await reload()
            }}
          />
        </>
      )}

      <ConfirmDialog
        isOpen={removing !== null}
        title={removing ? `Remove ${removing.name}?` : 'Remove account?'}
        message="Claude Code signs out of this account on this computer. Its chat history stays."
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
