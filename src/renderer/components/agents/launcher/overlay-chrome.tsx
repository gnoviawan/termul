import { X } from '@/components/icons'
import { cn } from '@/lib/utils'
import { useWorkspaceStore } from '@/stores/workspace-store'
import { LAUNCHER_BACKDROP_REVEAL_MS, LAUNCHER_DISMISS_MS } from './launcher-motion'

/**
 * Exit classification, chosen at the first exiting commit while the root
 * transform is still identity: `dismiss` fades the launcher in place; `morph`
 * FLIP-morphs the composer card onto the live ChatInputBar card (see
 * launcher-motion.ts).
 */
export type LauncherExitAnim =
  | { kind: 'dismiss' }
  | { kind: 'morph'; tx: number; ty: number; sx: number; sy: number; ox: number; oy: number }

/**
 * Overlay variant chrome (the Ctrl+T launcher over a pane): backdrop + close
 * control. The empty-pane launcher IS the pane content, so it gets neither —
 * the parent gates this on `showOverlayChrome`.
 */
export function LauncherOverlayChrome({
  isExiting,
  exitAnim,
  isMobileShell
}: {
  isExiting: boolean
  exitAnim: LauncherExitAnim | null
  isMobileShell: boolean
}): React.JSX.Element {
  return (
    <>
      {/* The overlay backdrop lives inside the launcher root so the exit
          can sequence it: a launch fades it gradually (revealing the chat
          instead of a sudden text pop-in) while a plain dismiss fades it
          with the launcher itself. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-background/95 backdrop-blur-sm"
        style={{
          opacity: isExiting && exitAnim !== null ? 0 : 1,
          transition: `opacity ${
            exitAnim?.kind === 'morph' ? LAUNCHER_BACKDROP_REVEAL_MS : LAUNCHER_DISMISS_MS
          }ms ease-out`
        }}
      />
      <button
        type="button"
        className={cn(
          'absolute z-20 flex shrink-0 items-center justify-center text-muted-foreground transition-[color,background-color,opacity] duration-150 hover:bg-muted/60 hover:text-foreground',
          isMobileShell ? 'right-2 top-2 size-11 rounded-lg' : 'right-3 top-3 h-8 w-8 rounded-md',
          isExiting && 'opacity-0'
        )}
        aria-label="Close agent launcher"
        title="Close agent launcher"
        onClick={() => useWorkspaceStore.getState().hideAgentLauncher()}
      >
        <X size={isMobileShell ? 22 : 16} />
      </button>
    </>
  )
}
