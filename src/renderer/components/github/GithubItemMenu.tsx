import type { GithubItemDetail, GithubItemStateAction } from '@shared/types/github.types'
import type { IpcResult } from '@shared/types/ipc.types'
import { useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { requestExternalLinkOpen } from '@/components/external-link/ExternalLinkConfirm'
import {
  ChevronDown,
  CircleCheck,
  CircleDot,
  CircleMinus,
  Copy,
  ExternalLink,
  MoreHorizontal,
  Tag,
  type TermulIcon,
  User
} from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { MobileSheetContent, SheetGroup, SheetRow } from '@/components/ui/mobile-sheet'
import { PANEL_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { Sheet, SheetTrigger } from '@/components/ui/sheet'
import { WriteGate, WriteGateReason } from '@/components/ui/write-gate'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { copyText } from '@/lib/copy-text'
import { logFrontendError } from '@/lib/log-api'
import { cn } from '@/lib/utils'
import { READ_ONLY_SERVER_REASON } from '@/lib/write-gate'
import {
  type GithubItemRef,
  githubRepoMetaKey,
  resourceOf,
  useGithubStore
} from '@/stores/github-store'
import { useOverlayRegistration } from '@/stores/overlay-stack-store'

const LOG_SOURCE = 'github.itemActions'

/**
 * Toast a refused write. A timeout may still have applied on GitHub; the
 * re-read that follows every write shows what GitHub now reports.
 */
export function reportGithubWriteFailure(
  what: string,
  result: Extract<IpcResult<unknown>, { success: false }>
): void {
  void logFrontendError({
    level: 'warn',
    source: LOG_SOURCE,
    message: `${what} failed: ${result.code}`
  })
  if (result.code === 'GH_TIMEOUT') {
    toast.error("GitHub didn't answer in time. Try again.")
    return
  }
  toast.error(`Couldn't ${what}`, { description: result.error || undefined })
}

interface StateAction {
  key: string
  label: string
  /** A second line ("as completed"). */
  detail?: string
  Icon: TermulIcon
  action: GithubItemStateAction
}

/** Close and reopen choices GitHub offers for the item's kind and state; none for a merged PR. */
function stateActions(detail: GithubItemDetail): StateAction[] {
  const { kind, state } = detail.item
  if (kind === 'issue') {
    return state === 'open'
      ? [
          {
            key: 'close',
            label: 'Close issue',
            detail: 'as completed',
            Icon: CircleCheck,
            action: { kind: 'close', reason: 'completed' }
          },
          {
            key: 'not_planned',
            label: 'Close as not planned',
            Icon: CircleMinus,
            action: { kind: 'close', reason: 'not_planned' }
          }
        ]
      : [{ key: 'reopen', label: 'Reopen issue', Icon: CircleDot, action: { kind: 'reopen' } }]
  }
  if (state === 'merged') return []
  return state === 'closed'
    ? [{ key: 'reopen', label: 'Reopen pull request', Icon: CircleDot, action: { kind: 'reopen' } }]
    : [
        {
          key: 'close',
          label: 'Close pull request',
          Icon: CircleMinus,
          action: { kind: 'close', reason: 'completed' }
        }
      ]
}

/**
 * The item's write actions shared by the ⋯ menu and the desktop state
 * button: assign or unassign the signed-in account, close and reopen. Each
 * runs through the store, which re-reads the item and the list after it.
 */
export function useGithubItemActions(itemRef: GithubItemRef, detail: GithubItemDetail) {
  const admitsWrites = useServerAdmitsRemoteWrites()
  const meta = useGithubStore((s) =>
    resourceOf(s.repoMeta[githubRepoMetaKey(itemRef.cwd, itemRef.repo)])
  )
  const [busy, setBusy] = useState(false)
  const viewer = meta.data?.viewer ?? null
  const assignedToMe = viewer !== null && detail.item.assignees.includes(viewer)
  /**
   * `assign`/`unassign` for the signed-in account, `loading` before the repo
   * meta arrives, null when GitHub would not let it be assigned here
   * (not a collaborator on this repository).
   */
  const selfAction: 'assign' | 'unassign' | 'loading' | null =
    viewer === null
      ? meta.status === 'error'
        ? null
        : 'loading'
      : assignedToMe
        ? 'unassign'
        : meta.data?.assignableUsers.includes(viewer)
          ? 'assign'
          : null

  const loadMeta = (): void => {
    if (!meta.data && meta.status !== 'loading') {
      void useGithubStore.getState().loadRepoMeta(itemRef.cwd, itemRef.repo)
    }
  }

  const write = async (what: string, run: () => Promise<IpcResult<unknown>>): Promise<void> => {
    setBusy(true)
    try {
      const result = await run()
      if (!result.success) reportGithubWriteFailure(what, result)
    } finally {
      setBusy(false)
    }
  }

  return {
    gated: !admitsWrites,
    busy,
    viewer,
    assignedToMe,
    selfAction,
    loadMeta,
    stateActions: stateActions(detail),
    toggleSelf: () => {
      if (viewer === null || (selfAction !== 'assign' && selfAction !== 'unassign')) return
      void write(assignedToMe ? 'unassign you' : 'assign you', () =>
        useGithubStore
          .getState()
          .editItem(
            itemRef,
            assignedToMe ? { removeAssignees: [viewer] } : { addAssignees: [viewer] }
          )
      )
    },
    setState: (action: StateAction) => {
      void write(action.label.toLowerCase(), () =>
        useGithubStore.getState().setItemState(itemRef, action.action)
      )
    }
  }
}

interface GithubItemMenuProps {
  itemRef: GithubItemRef
  detail: GithubItemDetail
  onEditLabels: () => void
  onEditAssignees: () => void
}

/**
 * The item's ⋯ menu (mockup F): edit labels and assignees, assign yourself,
 * open or copy the link, close and reopen. A sheet on the phone shell, a
 * dropdown on desktop. Writes are gated on a read-only server.
 */
export function GithubItemMenu({
  itemRef,
  detail,
  onEditLabels,
  onEditAssignees
}: GithubItemMenuProps): React.JSX.Element {
  const isMobile = useMobileWebShell()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // A picker opened from the menu keeps focus; the menu must not pull it back to ⋯.
  const handingOff = useRef(false)
  const overlayId = `github-item-menu:${useId()}`
  useOverlayRegistration(overlayId, open && isMobile, () => setOpen(false), {
    mobileShellOnly: true
  })
  const actions = useGithubItemActions(itemRef, detail)
  const { item, repo } = detail
  const noun = item.kind === 'pr' ? 'Pull request' : 'Issue'

  const onOpenChange = (next: boolean): void => {
    if (next) {
      handingOff.current = false
      actions.loadMeta()
    }
    setOpen(next)
  }
  const handOff = (openEditor: () => void): void => {
    handingOff.current = true
    setOpen(false)
    openEditor()
  }
  const onCloseAutoFocus = (event: Event): void => {
    if (handingOff.current) event.preventDefault()
  }
  const openOnGithub = (): void => {
    requestExternalLinkOpen(item.url, { returnFocusTo: triggerRef.current })
  }
  const copyLink = (): void => {
    void copyText(item.url).then((copied) => {
      if (copied) toast.success('Link copied')
      else toast.error("Couldn't copy the link")
    })
  }
  const selfLabel = actions.assignedToMe ? 'Unassign me' : 'Assign to me'
  const writeOff = actions.gated || actions.busy

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      aria-label={`${noun} actions`}
      title="More actions"
      className={cn(PANEL_ICON_BUTTON_CLASS, 'pointer-coarse:size-11')}
    >
      <MoreHorizontal size={16} aria-hidden="true" />
    </button>
  )

  if (isMobile) {
    const gatedSubtitle = actions.gated ? READ_ONLY_SERVER_REASON : undefined
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <MobileSheetContent
          title={`${noun} #${item.number}`}
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <p className="truncate text-center text-xs text-muted-foreground">
            {repo.owner}/{repo.name}
          </p>
          <SheetGroup>
            <SheetRow
              title="Edit labels"
              icon={<Tag size={18} aria-hidden="true" />}
              accessory="chevron"
              onSelect={() => handOff(onEditLabels)}
            />
            {actions.selfAction !== null && (
              <SheetRow
                title={selfLabel}
                subtitle={gatedSubtitle}
                icon={<User size={18} aria-hidden="true" />}
                disabled={writeOff || actions.selfAction === 'loading'}
                onSelect={() => {
                  actions.toggleSelf()
                  setOpen(false)
                }}
              />
            )}
            <SheetRow
              title="Edit assignees"
              icon={<User size={18} aria-hidden="true" />}
              accessory="chevron"
              onSelect={() => handOff(onEditAssignees)}
            />
            <SheetRow
              title="Open on GitHub"
              icon={<ExternalLink size={18} aria-hidden="true" />}
              onSelect={() => {
                setOpen(false)
                openOnGithub()
              }}
            />
            <SheetRow
              title="Copy link"
              icon={<Copy size={18} aria-hidden="true" />}
              onSelect={() => {
                setOpen(false)
                copyLink()
              }}
            />
          </SheetGroup>
          {actions.stateActions.length > 0 && (
            <SheetGroup>
              {actions.stateActions.map((state) => (
                <SheetRow
                  key={state.key}
                  title={state.label}
                  subtitle={gatedSubtitle}
                  value={state.detail}
                  icon={<state.Icon size={18} aria-hidden="true" />}
                  disabled={writeOff}
                  onSelect={() => {
                    actions.setState(state)
                    setOpen(false)
                  }}
                />
              ))}
            </SheetGroup>
          )}
        </MobileSheetContent>
      </Sheet>
    )
  }

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52" onCloseAutoFocus={onCloseAutoFocus}>
        <DropdownMenuItem onSelect={() => handOff(onEditLabels)}>
          <Tag size={14} aria-hidden="true" /> Edit labels
        </DropdownMenuItem>
        {actions.selfAction !== null && (
          <WriteGate gated={actions.gated} focusable={false} className="flex w-full">
            <DropdownMenuItem
              disabled={writeOff || actions.selfAction === 'loading'}
              onSelect={actions.toggleSelf}
            >
              <User size={14} aria-hidden="true" /> {selfLabel}
              {actions.gated && <WriteGateReason />}
            </DropdownMenuItem>
          </WriteGate>
        )}
        <DropdownMenuItem onSelect={() => handOff(onEditAssignees)}>
          <User size={14} aria-hidden="true" /> Edit assignees
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={openOnGithub}>
          <ExternalLink size={14} aria-hidden="true" /> Open on GitHub
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={copyLink}>
          <Copy size={14} aria-hidden="true" /> Copy link
        </DropdownMenuItem>
        {actions.stateActions.length > 0 && <DropdownMenuSeparator />}
        {actions.stateActions.map((state) => (
          <WriteGate
            key={state.key}
            gated={actions.gated}
            focusable={false}
            className="flex w-full"
          >
            <DropdownMenuItem disabled={writeOff} onSelect={() => actions.setState(state)}>
              <state.Icon size={14} aria-hidden="true" /> {state.label}
              {state.detail && (
                <span className="ml-auto pl-3 text-muted-foreground">{state.detail}</span>
              )}
              {actions.gated && <WriteGateReason />}
            </DropdownMenuItem>
          </WriteGate>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Desktop header button for the item's state (mockup G): "Close issue ▾"
 * with both close reasons, or a single Close / Reopen button.
 */
export function GithubStateButton({
  itemRef,
  detail
}: {
  itemRef: GithubItemRef
  detail: GithubItemDetail
}): React.JSX.Element | null {
  const actions = useGithubItemActions(itemRef, detail)
  const [first, ...rest] = actions.stateActions
  if (!first) return null
  const disabled = actions.gated || actions.busy
  const label = (
    <>
      <first.Icon size={14} aria-hidden="true" />
      {actions.busy ? 'Saving…' : first.label}
    </>
  )
  if (rest.length === 0) {
    return (
      <WriteGate gated={actions.gated}>
        <Button
          variant="outline"
          size="xs"
          className="gap-1.5"
          disabled={disabled}
          onClick={() => actions.setState(first)}
        >
          {label}
        </Button>
      </WriteGate>
    )
  }
  return (
    <DropdownMenu>
      <WriteGate gated={actions.gated}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="xs" className="gap-1.5" disabled={disabled}>
            {label}
            <ChevronDown size={12} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
      </WriteGate>
      <DropdownMenuContent align="end" className="min-w-52">
        {actions.stateActions.map((state) => (
          <DropdownMenuItem key={state.key} onSelect={() => actions.setState(state)}>
            <state.Icon size={14} aria-hidden="true" /> {state.label}
            {state.detail && (
              <span className="ml-auto pl-3 text-muted-foreground">{state.detail}</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
