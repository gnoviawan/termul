import { useTheme } from 'next-themes'
import { Toaster as Sonner, toast } from 'sonner'

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      // Stack collapses to a peeking pile; expands when hovered. Subtle
      // delight that also reveals queued toasts without forcing them
      // open all the time.
      expand={false}
      // Cap visible stack so a flood of toasts (e.g. failing batch op)
      // doesn't take over the screen. Older toasts still queue silently.
      visibleToasts={4}
      // Always render a close button. Auto-dismiss alone leaves users
      // unsure whether they can dismiss early.
      closeButton
      // Semantic colour tints (success/info/warning/error) instead of
      // outline-only. Feels more native; readable at a glance.
      richColors
      // Comfortable distance from screen edge.
      offset={20}
      // Default 4s is fine for success; errors deserve a touch longer
      // because they usually need reading. Per-call duration on toast()
      // still wins over this.
      duration={4000}
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground'
        }
      }}
      {...props}
    />
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export { Toaster, toast }
