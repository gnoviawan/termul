import { useTheme } from 'next-themes'
import { Toaster as Sonner, toast } from 'sonner'
import 'sonner/dist/styles.css'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme()
  // Story 11 (QA F9): sonner's stack expansion is hover-driven
  // (mouseenter/mousemove set `expanded`) — on touch there is no hover, so
  // `expand={false}` left queued toasts permanently hidden behind the front
  // toast over the terminal key bar. Verified against sonner@1.7.4's dist
  // source: the only tap handlers set the transient `interacting` flag, not
  // `expanded`. On the mobile web shell default the stack to expanded
  // (expand=true) and lift the offset clear of the key bar + home indicator;
  // desktop keeps the collapsed hover-expand pile byte-identical.
  const isMobileWebShell = useMobileWebShell()

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      expand={isMobileWebShell || false}
      // Cap visible stack so a flood of toasts (e.g. failing batch op)
      // doesn't take over the screen. Older toasts still queue silently.
      visibleToasts={4}
      // Always render a close button. Auto-dismiss alone leaves users
      // unsure whether they can dismiss early.
      closeButton
      // Semantic colour tints (success/info/warning/error) instead of
      // outline-only. Feels more native; readable at a glance.
      richColors
      // Comfortable distance from screen edge. Mobile: 88px lifts the stack
      // clear of the terminal key bar (~56px) + home indicator.
      offset={isMobileWebShell ? 88 : 20}
      // Default 4s is fine for success; errors deserve a touch longer
      // because they usually need reading. Per-call duration on toast()
      // still wins over this.
      duration={4000}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          default: 'group-[.toaster]:bg-background group-[.toaster]:text-foreground',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground'
        }
      }}
      {...props}
    />
  )
}

export { Toaster, toast }
