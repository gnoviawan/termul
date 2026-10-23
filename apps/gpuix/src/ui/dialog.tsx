import type { PublicInstance } from '@gpuix/react'
import { forwardRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { X } from '../icons'
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

const Dialog = (props: ModalRootProps) => <ModalRoot {...props} />

const DialogTrigger = forwardRef<PublicInstance, PressProps>((props, ref) => (
  <ModalPress ref={ref} opens {...props} />
))
DialogTrigger.displayName = 'DialogTrigger'

const DialogClose = forwardRef<PublicInstance, PressProps>((props, ref) => (
  <ModalPress ref={ref} opens={false} {...props} />
))
DialogClose.displayName = 'DialogClose'

/** GPUIX portals the whole content; this exists so call sites that name it still compile. */
const DialogPortal = ({ children }: { children?: ReactNode }) => <>{children}</>

export const DIALOG_OVERLAY_CLASS =
  'fixed inset-0 z-50 bg-overlay/90 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none!'

export const DIALOG_CONTENT_CLASS =
  'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-card p-6 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 rounded-2xl motion-reduce:animate-none!'

const DIALOG_CLOSE_CLASS =
  'absolute right-4 top-4 rounded-lg opacity-70 ring-offset-background transition-opacity hover:bg-secondary hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none pointer-coarse:right-0.5 pointer-coarse:top-0.5 pointer-coarse:flex pointer-coarse:size-11 pointer-coarse:items-center pointer-coarse:justify-center pointer-coarse:focus:ring-offset-0'

/** The overlay is part of DialogContent; a standalone one paints the same scrim. */
const DialogOverlay = forwardRef<PublicInstance, HostProps>(({ className, ...props }, ref) => (
  <Box ref={ref} {...props} className={cn(DIALOG_OVERLAY_CLASS, className)} />
))
DialogOverlay.displayName = 'DialogOverlay'

const DialogContent = forwardRef<PublicInstance, ModalContentProps>(
  ({ className, children, ...props }, ref) => (
    <ModalContent
      ref={ref}
      {...props}
      dismissOnBackdrop
      overlayClassName={DIALOG_OVERLAY_CLASS}
      className={centeredClasses(cn(DIALOG_CONTENT_CLASS, className))}
      after={
        <DialogClose className={DIALOG_CLOSE_CLASS} aria-label="Close">
          <X className="h-4 w-4" />
        </DialogClose>
      }
    >
      {children}
    </ModalContent>
  )
)
DialogContent.displayName = 'DialogContent'

const DialogHeader = part('flex flex-col space-y-1.5 text-center sm:text-left')
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = part('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2')
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = part('text-lg font-semibold leading-none tracking-tight', 'heading')
DialogTitle.displayName = 'DialogTitle'

const DialogDescription = part('text-sm text-muted-foreground')
DialogDescription.displayName = 'DialogDescription'

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger
}
