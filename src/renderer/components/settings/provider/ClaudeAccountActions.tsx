import { MoreHorizontal } from '@/components/icons'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

interface ClaudeAccountActionsProps {
  accountName: string
  builtin: boolean
  isDefault: boolean
  signedOut: boolean
  ready: boolean
  canManage: boolean
  busy: boolean
  onSignIn: () => void
  onMakeDefault: () => void
  onRename: () => void
  onRemove: () => void
}

/** Settings → Provider row menu (⋯). Holds every row action except the primary one. */
export function ClaudeAccountActions({
  accountName,
  builtin,
  isDefault,
  signedOut,
  ready,
  canManage,
  busy,
  onSignIn,
  onMakeDefault,
  onRename,
  onRemove
}: ClaudeAccountActionsProps): React.JSX.Element {
  if (isDefault && !canManage) return <span aria-hidden="true" className="size-7" />
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={`Actions for ${accountName}`}
          disabled={busy}
          className="text-muted-foreground data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-foreground"
        >
          <MoreHorizontal size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {!isDefault && (
          <DropdownMenuItem disabled={!ready} onSelect={onMakeDefault}>
            <span className="flex flex-col">
              <span>Make default</span>
              {!ready && (
                <span className="text-2xs text-muted-foreground">Sign in to it first</span>
              )}
            </span>
          </DropdownMenuItem>
        )}
        {canManage && (
          <>
            <DropdownMenuItem onSelect={onSignIn}>
              {signedOut ? 'Sign in' : 'Sign in again'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
          </>
        )}
        {canManage && !builtin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onRemove}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            >
              Remove
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
