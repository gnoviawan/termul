import { Fragment, useRef } from 'react'
import { Paperclip, Plus, RefreshCw, Server, Settings2, Wrench } from '@/components/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { MENU_SHORTCUT_CLASS } from '@/components/ui/menu-styles'
import { SwitchMark } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { logFrontendError } from '@/lib/log-api'
import { useSettingsModalStore } from '@/stores/settings-modal-store'
import type { McpServerListProps } from '../McpServerList'
import { TERMUL_TOOL_ICONS } from '../ToolChip'
import type { ComposerAddHandle } from './ComposerAddSheet'
import { type ConnectorsHost, connectorsMenuModel } from './connectors-menu-model'
import type { TermulToolRow } from './use-termul-tools'

const LOG_SOURCE = 'composer-add-menu'
const ICON = 'mr-2 shrink-0 text-muted-foreground'
const NOTE = 'px-2 py-1.5 text-2xs text-muted-foreground'

interface ComposerAddMenuProps {
  handle: ComposerAddHandle
  /** Session closed: the editor is unavailable. */
  disabled: boolean
  connectors: Omit<McpServerListProps, 'listClassName'>
  connectorsHost: ConnectorsHost
  termulTools: TermulToolRow[]
}

function openConnectorSettings(): void {
  useSettingsModalStore.getState().openApp('mcp-servers')
}

/**
 * The desktop composer's `+`: attach, mention, slash commands, Troupe's own
 * tools, and the project's connectors (MCP servers). The phone shell uses `ComposerAddSheet`.
 */
export function ComposerAddMenu({
  handle,
  disabled,
  connectors,
  connectorsHost,
  termulTools
}: ComposerAddMenuProps): React.JSX.Element {
  const model = connectorsMenuModel(connectors.servers, connectors.probeStatus, connectorsHost)
  // What to do once the menu has closed. Radix traps focus while the menu is
  // open, so an editor insert has to wait until the close hands focus back.
  // `null` returns focus to the editor (Escape); `'keep'` leaves it alone
  // (a click outside, or a settings page that takes focus itself).
  const afterCloseRef = useRef<(() => void) | 'keep' | null>(null)

  const onAttach = (): void => {
    // The picker needs this click's user activation, so it opens now.
    Promise.resolve(handle.pickFiles()).catch((err: unknown) => {
      void logFrontendError({
        level: 'warn',
        source: LOG_SOURCE,
        message: `Attach files failed: ${err instanceof Error ? err.name : 'unknown error'}`
      })
    })
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Add to chat"
              className="relative flex size-8 items-center justify-center text-muted-foreground transition-[color,transform] ease-out after:absolute after:-inset-1.5 after:content-[''] hover:text-foreground data-[state=open]:text-foreground"
            >
              <Plus size={16} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Add files, mentions and connectors</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        side="top"
        className="w-56"
        onInteractOutside={() => {
          afterCloseRef.current = 'keep'
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const next = afterCloseRef.current
          afterCloseRef.current = null
          if (next === 'keep') return
          if (next) next()
          else handle.focusEditor()
        }}
      >
        <DropdownMenuItem disabled={!handle.canPick} onSelect={onAttach}>
          <Paperclip size={14} aria-hidden="true" className={ICON} />
          {handle.canPickImages ? 'Add files or photos' : 'Add files'}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onSelect={() => {
            afterCloseRef.current = () => handle.insertTrigger('@')
          }}
        >
          <span aria-hidden="true" className={`${ICON} w-3.5 text-center`}>
            @
          </span>
          Mention
          <DropdownMenuShortcut>@</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onSelect={() => {
            afterCloseRef.current = () => handle.insertTrigger('/')
          }}
        >
          <span aria-hidden="true" className={`${ICON} w-3.5 text-center`}>
            /
          </span>
          Slash commands
          <DropdownMenuShortcut>/</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={disabled}>
            <Wrench size={14} aria-hidden="true" className={ICON} />
            Troupe tools
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-64">
            <DropdownMenuLabel>Ask the agent to use</DropdownMenuLabel>
            {termulTools.map(({ tool, state }) => {
              const Icon = TERMUL_TOOL_ICONS[tool.id]
              return (
                <DropdownMenuItem
                  key={tool.id}
                  onSelect={() => {
                    afterCloseRef.current = () => handle.insertTool(tool.id)
                  }}
                >
                  <span aria-hidden="true" className={`${ICON} self-start pt-0.5`}>
                    <Icon size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{tool.label}</span>
                    <span className="block truncate text-2xs text-muted-foreground">
                      {tool.description}
                    </span>
                  </span>
                  {state === 'closed' ? <span className={MENU_SHORTCUT_CLASS}>Closed</span> : null}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger trailing={`${model.onCount} on`}>
            <Server size={14} aria-hidden="true" className={ICON} />
            Connectors
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-[min(26rem,var(--radix-dropdown-menu-content-available-height))] w-64 overflow-y-auto">
            <DropdownMenuItem
              onSelect={() => {
                afterCloseRef.current = 'keep'
                openConnectorSettings()
              }}
            >
              <Settings2 size={14} aria-hidden="true" className={ICON} />
              Manage connectors
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {model.rows.length === 0 ? <p className={NOTE}>No connectors yet</p> : null}
            {model.rows.map((row) => (
              <Fragment key={row.id}>
                <DropdownMenuItem
                  role="menuitemcheckbox"
                  aria-checked={row.on}
                  onSelect={(event) => {
                    event.preventDefault()
                    connectors.onToggle?.(row.id, !row.on)
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{row.name}</span>
                  <span className="ml-auto pl-4">
                    <SwitchMark on={row.on} />
                  </span>
                </DropdownMenuItem>
                {row.needsSignIn ? (
                  <DropdownMenuItem
                    aria-label={`Sign in to ${row.name}`}
                    className="pl-4 text-muted-foreground"
                    onSelect={() => {
                      afterCloseRef.current = 'keep'
                      openConnectorSettings()
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate text-2xs">Needs sign-in</span>
                    <span className={MENU_SHORTCUT_CLASS}>Sign in</span>
                  </DropdownMenuItem>
                ) : null}
              </Fragment>
            ))}
            {model.footnote === 'next-chat' ? (
              <p className={NOTE}>Takes effect on the next chat.</p>
            ) : null}
            {model.footnote === 'reload-chat' ? (
              <>
                <DropdownMenuSeparator />
                <p className={NOTE}>This chat still uses the previous servers.</p>
                <DropdownMenuItem
                  disabled={connectors.reloadDisabled || connectors.reloading}
                  title={
                    connectors.reloadDisabled
                      ? (connectors.reloadDisabledReason ?? undefined)
                      : undefined
                  }
                  onSelect={() => {
                    // A reload may ask to confirm first; that dialog takes focus.
                    afterCloseRef.current = 'keep'
                    connectors.onReloadChat?.()
                  }}
                >
                  <RefreshCw size={14} aria-hidden="true" className={ICON} />
                  {connectors.reloading ? 'Reloading…' : 'Reload this chat'}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
