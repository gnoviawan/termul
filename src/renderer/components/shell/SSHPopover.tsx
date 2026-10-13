import { useEffect, useMemo, useRef, useState } from 'react'
import { Network } from '@/components/icons'
import { railButtonClass } from '@/components/shell/rail-button'
import { SSHPanel } from '@/components/ssh/SSHPanel'
import {
  SSHPanelDialogs,
  type SSHPanelDialogsController,
  useSSHPanelDialogs
} from '@/components/ssh/SSHPanelDialogs'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useNativeWebviewOcclusion } from '@/hooks/use-native-webview-occlusion'
import { isTauriContext } from '@/lib/tauri-runtime'

interface SSHPopoverProps {
  onSSHConnect?: (profileId: string) => void
  onSelectProfile?: (profileId: string) => void
  activeProfileId?: string | null
}

/**
 * Collapsed-Rail SSH entry (revamp, desktop only): an icon that opens the same
 * host list and actions as the sidebar section. The host editor and delete
 * confirm live outside the popover: a request closes the popover first, then
 * opens the dialog, and focus returns to the icon once the dialog closes.
 */
export function SSHPopover({
  onSSHConnect,
  onSelectProfile,
  activeProfileId
}: SSHPopoverProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogs = useSSHPanelDialogs()
  const dialogOpen = dialogs.isOpen
  const wasDialogOpen = useRef(false)

  useNativeWebviewOcclusion(open)

  // Both dialogs are plain overlays that never return focus, so put it back on
  // the icon once the dialog has closed.
  useEffect(() => {
    const closed = wasDialogOpen.current && !dialogOpen
    wasDialogOpen.current = dialogOpen
    if (!closed) return
    const timer = setTimeout(() => triggerRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [dialogOpen])

  const popoverDialogs = useMemo<SSHPanelDialogsController>(
    () => ({
      ...dialogs,
      openForm: (profile) => {
        setOpen(false)
        dialogs.openForm(profile)
      },
      requestDelete: (profile) => {
        setOpen(false)
        dialogs.requestDelete(profile)
      }
    }),
    [dialogs]
  )

  // Desktop-only surface (issue #843): connect/SFTP are unsupported on web.
  if (!isTauriContext()) return null

  return (
    <>
      <TooltipProvider delayDuration={400}>
        <Popover open={open} onOpenChange={setOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  ref={triggerRef}
                  type="button"
                  className={railButtonClass(open)}
                  aria-label="SSH hosts"
                >
                  <Network size={16} />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="right" className="px-2.5 py-1.5 text-xs">
              SSH
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            side="right"
            align="start"
            className="h-80 w-72 overflow-hidden p-0"
            onCloseAutoFocus={(e) => {
              // A dialog is taking over; focus returns to the icon when it closes.
              if (dialogs.isOpen) e.preventDefault()
            }}
          >
            <SSHPanel
              onConnect={onSSHConnect}
              onSelectProfile={onSelectProfile}
              activeProfileId={activeProfileId}
              dialogs={popoverDialogs}
              focusableRows
            />
          </PopoverContent>
        </Popover>
      </TooltipProvider>
      <SSHPanelDialogs controller={dialogs} />
    </>
  )
}
