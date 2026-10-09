import { Toaster as Sonner, toast } from 'sonner'
import 'sonner/dist/styles.css'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useAppearanceMode } from '@/stores/app-settings-store'
import './sonner.css'

type ToasterProps = React.ComponentProps<typeof Sonner>

/**
 * Bottom offset (px) of the toast stack on the mobile web shell: clear of the
 * dock instead of covering the composer. 160 = the one-row composer card (100:
 * editor block 46 + toolbar row 44 + 8 bottom padding + 2 borders) + the
 * `ChatInputBar` `pb-6` (24) + the `StatusBar` `h-6` (24) that the mobile shell
 * renders below the chat pane + a 12 gap. The offset is measured from the
 * viewport bottom, so the status bar counts: without it the toast's bottom edge
 * lands 12px inside the card instead of 12px above it. It also clears the
 * terminal key bar. The variable parts of the dock (changed files, queue,
 * approval) are not counted here.
 */
const MOBILE_TOAST_BOTTOM_OFFSET_PX = 160
const MOBILE_TOAST_OFFSET = { bottom: MOBILE_TOAST_BOTTOM_OFFSET_PX }

const Toaster = ({ ...props }: ToasterProps) => {
  const appearanceMode = useAppearanceMode()
  // Story 11 (QA F9): sonner's stack expansion is hover-driven
  // (mouseenter/mousemove set `expanded`) — on touch there is no hover, so
  // `expand={false}` left queued toasts permanently hidden behind the front
  // toast over the terminal key bar. Verified against sonner@1.7.4's dist
  // source: the only tap handlers set the transient `interacting` flag, not
  // `expanded`. On the mobile web shell default the stack to expanded
  // (expand=true) and lift the offset clear of the composer dock and key bar;
  // desktop keeps the collapsed hover-expand pile byte-identical.
  const isMobileWebShell = useMobileWebShell()

  return (
    <Sonner
      theme={appearanceMode}
      className="toaster group"
      expand={isMobileWebShell || false}
      // Cap visible stack so a flood of toasts (e.g. failing batch op)
      // doesn't take over the screen. Older toasts still queue silently.
      visibleToasts={4}
      // Always render a close button. Auto-dismiss alone leaves users
      // unsure whether they can dismiss early.
      closeButton
      // Comfortable distance from screen edge. Mobile: lift the stack above the
      // composer dock (see MOBILE_TOAST_BOTTOM_OFFSET_PX). sonner 1.7.4 applies
      // `offset` only above 600px and `mobileOffset` (default 16px) at 600px and
      // below, so both are set. The object form moves only the bottom edge; a
      // number would also set left and right and squeeze the toast.
      offset={isMobileWebShell ? MOBILE_TOAST_OFFSET : 20}
      mobileOffset={isMobileWebShell ? MOBILE_TOAST_OFFSET : undefined}
      // Default 4s is fine for success; errors deserve a touch longer
      // because they usually need reading. Per-call duration on toast()
      // still wins over this.
      duration={4000}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-card group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton: 'group-[.toast]:bg-primary-fill group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-secondary group-[.toast]:text-secondary-foreground'
        }
      }}
      {...props}
    />
  )
}

export { Toaster, toast }
