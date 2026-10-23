import type { PublicInstance } from '@gpuix/react'
import type { VariantProps } from 'class-variance-authority'
import { forwardRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { sheetVariants } from '../../../../src/renderer/components/ui/sheet-variants'
import { X } from '../icons'
import { Box, type HostProps } from './internal/host'
import {
  ModalContent,
  type ModalContentProps,
  ModalPress,
  ModalRoot,
  type ModalRootProps,
  type PressProps,
  part
} from './internal/modal'

const Sheet = (props: ModalRootProps) => <ModalRoot {...props} />

const SheetTrigger = forwardRef<PublicInstance, PressProps>((props, ref) => (
  <ModalPress ref={ref} opens {...props} />
))
SheetTrigger.displayName = 'SheetTrigger'

const SheetClose = forwardRef<PublicInstance, PressProps>((props, ref) => (
  <ModalPress ref={ref} opens={false} {...props} />
))
SheetClose.displayName = 'SheetClose'

const SheetPortal = ({ children }: { children?: ReactNode }) => <>{children}</>

const SHEET_OVERLAY_CLASS =
  'fixed inset-0 z-50 bg-overlay/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none!'

/** `CHAT_ROW_ICON` from components/chat/chat-layout, inlined to keep chat out of the ui bundle. */
const CHAT_ROW_ICON = 'size-7 pointer-coarse:size-11'

const SHEET_CLOSE_CLASS = cn(
  'absolute right-2.5 top-2.5 flex items-center justify-center pointer-coarse:right-0.5 pointer-coarse:top-0.5',
  CHAT_ROW_ICON,
  'rounded-sm opacity-70 ring-offset-background transition-opacity data-[state=open]:bg-secondary hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 pointer-coarse:focus:ring-offset-0 disabled:pointer-events-none'
)

const SheetOverlay = forwardRef<PublicInstance, HostProps>(({ className, ...props }, ref) => (
  <Box ref={ref} {...props} className={cn(SHEET_OVERLAY_CLASS, className)} />
))
SheetOverlay.displayName = 'SheetOverlay'

interface SheetContentProps extends ModalContentProps, VariantProps<typeof sheetVariants> {}

const SheetContent = forwardRef<PublicInstance, SheetContentProps>(
  ({ side = 'right', className, children, ...props }, ref) => (
    <ModalContent
      ref={ref}
      data-sheet=""
      {...props}
      dismissOnBackdrop
      overlayClassName={SHEET_OVERLAY_CLASS}
      className={cn(sheetVariants({ side }), className)}
      after={
        <SheetClose className={SHEET_CLOSE_CLASS} aria-label="Close">
          <X className="h-4 w-4" />
        </SheetClose>
      }
    >
      {children}
    </ModalContent>
  )
)
SheetContent.displayName = 'SheetContent'

const SheetHeader = part('flex flex-col space-y-2 text-center sm:text-left')
SheetHeader.displayName = 'SheetHeader'

const SheetFooter = part('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2')
SheetFooter.displayName = 'SheetFooter'

const SheetTitle = part('text-lg font-semibold text-foreground', 'heading')
SheetTitle.displayName = 'SheetTitle'

const SheetDescription = part('text-sm text-muted-foreground')
SheetDescription.displayName = 'SheetDescription'

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger
}
