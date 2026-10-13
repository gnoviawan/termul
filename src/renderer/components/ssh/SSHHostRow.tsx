import type { SSHProfile } from '@shared/types/ssh.types'
import { Copy, MoreHorizontal, Pencil, Pin, Terminal, Trash2 } from '@/components/icons'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { FOCUS_RING_CLASS, QUIET_ICON_BUTTON_CLASS } from '@/components/ui/panel-styles'
import { addressLabel, authMethodLabel } from '@/lib/ssh-messages'
import { cn } from '@/lib/utils'
import { hostStateWord, SSHHostLamp, type SSHHostState } from './ssh-host-status'

export interface SSHHostActions {
  connect: (profile: SSHProfile) => void
  edit: (profile: SSHProfile) => void
  duplicate: (profile: SSHProfile) => void
  toggleFavorite: (profile: SSHProfile) => void
  remove: (profile: SSHProfile) => void
}

interface SSHHostRowProps {
  profile: SSHProfile
  state: SSHHostState
  /** Open session tabs for this host */
  sessionCount: number
  selected: boolean
  canConnect: boolean
  /** user@host:port, else only the sign-in method (privacy) */
  showAddress: boolean
  actions: SSHHostActions
  /** Arrow keys move between rows */
  onArrow: (direction: 1 | -1, from: HTMLElement) => void
}

function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : name.trim().slice(0, 2)
  return letters.toUpperCase() || '?'
}

/** One host in the Hosts list: connect on click/Enter, actions in a menu. */
export function SSHHostRow({
  profile,
  state,
  sessionCount,
  selected,
  canConnect,
  showAddress,
  actions,
  onArrow
}: SSHHostRowProps): React.JSX.Element {
  const status =
    state === 'idle'
      ? null
      : sessionCount > 1
        ? `${hostStateWord(state)} · ${sessionCount} sessions`
        : hostStateWord(state)

  const menuItems = (
    Item: typeof DropdownMenuItem | typeof ContextMenuItem,
    Separator: typeof DropdownMenuSeparator | typeof ContextMenuSeparator
  ) => (
    <>
      {canConnect && (
        <Item onSelect={() => actions.connect(profile)}>
          <Terminal className="mr-2 h-4 w-4" />
          {sessionCount > 0 ? 'Open another session' : 'Connect'}
        </Item>
      )}
      <Item onSelect={() => actions.edit(profile)}>
        <Pencil className="mr-2 h-4 w-4" />
        Edit
      </Item>
      <Item onSelect={() => actions.duplicate(profile)}>
        <Copy className="mr-2 h-4 w-4" />
        Duplicate
      </Item>
      <Item onSelect={() => actions.toggleFavorite(profile)}>
        <Pin className="mr-2 h-4 w-4" />
        {profile.favorite ? 'Remove from favorites' : 'Add to favorites'}
      </Item>
      <Separator />
      <Item
        onSelect={() => actions.remove(profile)}
        className="text-destructive focus:bg-destructive/10 focus:text-destructive"
      >
        <Trash2 className="mr-2 h-4 w-4" />
        Delete
      </Item>
    </>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          className={cn(
            'group flex items-center gap-1 rounded-lg pr-1.5 transition-colors duration-150 ease-out',
            selected ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.03]'
          )}
          data-testid={`ssh-host-${profile.id}`}
        >
          <button
            type="button"
            className={cn(
              'flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2.5 py-2 text-left',
              FOCUS_RING_CLASS
            )}
            onClick={() => (canConnect ? actions.connect(profile) : actions.edit(profile))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                onArrow(e.key === 'ArrowDown' ? 1 : -1, e.currentTarget)
              }
            }}
            data-ssh-host-button=""
            aria-label={`${canConnect ? 'Connect to' : 'Edit'} ${profile.name}, ${showAddress ? `${addressLabel(profile)}, ` : ''}${authMethodLabel(profile.authMethod)}${status ? `, ${status}` : ''}`}
          >
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] font-mono text-xs font-semibold text-muted-foreground"
              aria-hidden="true"
            >
              {initials(profile.name)}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-sm font-medium text-foreground">{profile.name}</span>
                {profile.favorite && (
                  <Pin size={11} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                {showAddress && (
                  <>
                    <span className="truncate font-mono">{addressLabel(profile)}</span>
                    <span aria-hidden="true">·</span>
                  </>
                )}
                <span className="shrink-0">{authMethodLabel(profile.authMethod)}</span>
              </span>
              {profile.tags && profile.tags.length > 0 && (
                <span className="flex min-w-0 flex-wrap gap-1 pt-0.5">
                  {profile.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded bg-foreground/[0.06] px-1.5 py-px text-3xs text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </span>
              )}
            </span>
            {status && (
              <span className="flex shrink-0 items-center gap-1.5" aria-hidden="true">
                <SSHHostLamp state={state} />
                <span
                  className={cn(
                    'text-3xs',
                    state === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                  )}
                >
                  {status}
                </span>
              </span>
            )}
          </button>
          <button
            type="button"
            className={cn(QUIET_ICON_BUTTON_CLASS, 'size-7 shrink-0')}
            onClick={() => actions.edit(profile)}
            aria-label={`Edit ${profile.name}`}
            title="Edit"
          >
            <Pencil size={13} />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(QUIET_ICON_BUTTON_CLASS, 'size-7 shrink-0')}
                aria-label={`More actions for ${profile.name}`}
                title="More actions"
              >
                <MoreHorizontal size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {menuItems(DropdownMenuItem, DropdownMenuSeparator)}
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {menuItems(ContextMenuItem, ContextMenuSeparator)}
      </ContextMenuContent>
    </ContextMenu>
  )
}
