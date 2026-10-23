import { cva } from 'class-variance-authority'

// Mobile overlay radius scale (QA F7, story 12): bottom sheets round their
// top corners at `rounded-t-xl` (12px — the QA "quality bar" action sheet),
// centered modals use `rounded-2xl` (see Dialog/AlertDialog), side drawers
// are edge-to-edge (no radius). The variant default carries the token so
// call sites inherit the scale instead of hand-rolling per-sheet classes.

const sheetVariants = cva(
  // `motion-reduce:animate-none!` is important on purpose: `data-[state=open]:animate-in`
  // compiles to `.cls[data-state="open"]`, which outranks a bare utility, and the
  // sheet must open and unmount instantly under reduced motion.
  'fixed z-50 gap-4 bg-background p-6 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-200 data-[state=open]:duration-300 motion-reduce:animate-none!',
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
        bottom:
          'inset-x-0 bottom-0 border-t rounded-t-xl data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
        left: 'inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
        right:
          'inset-y-0 right-0 h-full w-3/4  border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm'
      }
    },
    defaultVariants: {
      side: 'right'
    }
  }
)

export { sheetVariants }
