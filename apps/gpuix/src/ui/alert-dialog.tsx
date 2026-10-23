import type { PublicInstance } from '@gpuix/react'
import { forwardRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { buttonVariants } from '../../../../src/renderer/components/ui/button-variants'
import { Box, type HostProps } from './internal/host'
import {
  centeredClasses,
  ModalContent,
  type ModalContentProps,
  ModalPress,
  ModalRoot,
  type ModalRootProps,
  type PressProps,
  part
} from './internal/modal'

/** Radix AlertDialog: a Dialog the backdrop cannot dismiss; Action and Cancel close it. */
const AlertDialog = (props: ModalRootProps) => <ModalRoot {...props} />

const AlertDialogTrigger = forwardRef<PublicInstance, PressProps>((props, ref) => (
  <ModalPress ref={ref} opens {...props} />
))
AlertDialogTrigger.displayName = 'AlertDialogTrigger'

const AlertDialogPortal = ({ children }: { children?: ReactNode }) => <>{children}</>

const ALERT_OVERLAY_CLASS =
  'fixed inset-0 z-50 bg-overlay/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'

const ALERT_CONTENT_CLASS =
  'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 rounded-2xl'

const AlertDialogOverlay = forwardRef<PublicInstance, HostProps>(({ className, ...props }, ref) => (
  <Box ref={ref} {...props} className={cn(ALERT_OVERLAY_CLASS, className)} />
))
AlertDialogOverlay.displayName = 'AlertDialogOverlay'

const AlertDialogContent = forwardRef<PublicInstance, ModalContentProps>(
  ({ className, ...props }, ref) => (
    <ModalContent
      ref={ref}
      role="alertdialog"
      {...props}
      dismissOnBackdrop={false}
      overlayClassName={ALERT_OVERLAY_CLASS}
      className={centeredClasses(cn(ALERT_CONTENT_CLASS, className))}
    />
  )
)
AlertDialogContent.displayName = 'AlertDialogContent'

const AlertDialogHeader = part('flex flex-col space-y-2 text-center sm:text-left')
AlertDialogHeader.displayName = 'AlertDialogHeader'

const AlertDialogFooter = part('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2')
AlertDialogFooter.displayName = 'AlertDialogFooter'

const AlertDialogTitle = part('text-lg font-semibold', 'heading')
AlertDialogTitle.displayName = 'AlertDialogTitle'

const AlertDialogDescription = part('text-sm text-muted-foreground')
AlertDialogDescription.displayName = 'AlertDialogDescription'

const AlertDialogAction = forwardRef<
  PublicInstance,
  PressProps & { 'data-press-feedback'?: string }
>(({ className, ...props }, ref) => (
  <ModalPress
    ref={ref}
    opens={false}
    {...props}
    className={cn(buttonVariants(), className)}
    state={{ keepShadow: true }}
  />
))
AlertDialogAction.displayName = 'AlertDialogAction'

const AlertDialogCancel = forwardRef<PublicInstance, PressProps>(({ className, ...props }, ref) => (
  <ModalPress
    ref={ref}
    opens={false}
    {...props}
    className={cn(buttonVariants({ variant: 'outline' }), 'mt-2 sm:mt-0', className)}
    state={{ keepShadow: true }}
  />
))
AlertDialogCancel.displayName = 'AlertDialogCancel'

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger
}
