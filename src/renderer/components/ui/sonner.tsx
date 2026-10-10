import { Toaster as Sonner, toast } from 'sonner'
import 'sonner/dist/styles.css'
import { DOCK_CLEARANCE_VAR } from '@/hooks/use-dock-clearance'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useAppearanceMode } from '@/stores/app-settings-store'
import './sonner.css'

type ToasterProps = React.ComponentProps<typeof Sonner>

/**
 * Bottom offset of the toast stack on the mobile web shell: a 12px gap above the
 * highest dock edge. `useDockClearance` measures the chat dock (composer, open
 * approval, changed-files bar, queue) and the terminal key bar and publishes the
 * distance from the viewport bottom to that edge as `--mobile-dock-height`;
 * sonner measures its offsets from the same bottom edge, so the dock's own
 * padding, the iOS keyboard spacer and the safe-area inset are already counted.
 * The variable exists only while a dock is on screen. The fallback is required:
 * an undefined variable would make the whole `bottom` declaration invalid, so
 * with no dock (editor, Git, browser tab) the stack sits one gap above the
 * safe-area inset.
 */
const MOBILE_TOAST_GAP = '12px'
const MOBILE_TOAST_OFFSET = {
  bottom: `calc(var(${DOCK_CLEARANCE_VAR}, env(safe-area-inset-bottom, 0px)) + ${MOBILE_TOAST_GAP})`
}

const Toaster = ({ ...props }: ToasterProps) => {
  const appearanceMode = useAppearanceMode()
  // Story 11 (QA F9): sonner's stack expansion is hover-driven
  // (mouseenter/mousemove set `expanded`) — on touch there is no hover, so
  // `expand={false}` left queued toasts permanently hidden behind the front
  // toast over the terminal key bar. Verified against sonner@1.7.4's dist
  // source: the only tap handlers set the transient `interacting` flag, not
  // `expanded`. On the mobile web shell default the stack to expanded
  // (expand=true) and lift the offset clear of the measured dock and key bar;
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
      // measured dock (see MOBILE_TOAST_OFFSET). sonner 1.7.4 applies `offset`
      // only above 600px and `mobileOffset` (default 16px) at 600px and below,
      // so both are set. The object form moves only the bottom edge; a number or
      // string would also set left and right and squeeze the toast.
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
