import { motion, useReducedMotion } from 'framer-motion'
import { useEffect, useRef } from 'react'
import { RailCollapsed } from '@/components/shell/RailCollapsed'
import { RailExpanded } from '@/components/shell/RailExpanded'
import { COLLAPSED_WIDTH } from '@/components/shell/rail-layout'
import { useRailResize } from '@/components/shell/use-rail-resize'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useWorktreeReconciler } from '@/hooks/use-worktree-reconciler'
import { EASE_OUT } from '@/lib/motion'
import { SHELL_LAYOUT_BOUNDS } from '@/stores/shell-layout-store'
import { useSidebarVisible } from '@/stores/sidebar-store'
import type { Project } from '@/types/project'

export interface ShellRailProps {
  projects: Project[]
  activeProject: Project | undefined
  activeProjectId: string
  onSelectProject: (id: string) => void
  onNewProject: () => void
  onSSHConnect: (profileId: string) => void
  onSelectSSHProfile: (profileId: string) => void
  activeSSHProfileId: string | null
  /** Opens the command palette (the Rail's Search). */
  onOpenCommandPalette: () => void
  /** Opens the active project's canvas tab. */
  onOpenCanvas: () => void
  /** Whether the canvas can be opened (the active project has a path). */
  canOpenCanvas: boolean
  isShortcutsOpen: boolean
  onShortcutsOpenChange: (open: boolean) => void
  isThemePickerOpen: boolean
  onToggleThemePicker?: () => void
}

/**
 * Shell frame Rail (shell revamp CAP-1): expanded (persisted width 180-360) or
 * collapsed to 48px of icons, following `railExpanded`. The width animates
 * with the sidebar timings (200ms open, 150ms close) and is instant under
 * reduced motion and while dragging the resize handle.
 */
export function ShellRail({
  projects,
  activeProject,
  activeProjectId,
  onSelectProject,
  onNewProject,
  onSSHConnect,
  onSelectSSHProfile,
  activeSSHProfileId,
  onOpenCommandPalette,
  onOpenCanvas,
  canOpenCanvas,
  isShortcutsOpen,
  onShortcutsOpenChange,
  isThemePickerOpen,
  onToggleThemePicker
}: ShellRailProps): React.JSX.Element {
  const reducedMotion = useReducedMotion() ?? false
  const expanded = useSidebarVisible()
  const { width, onResizeMouseDown, onResizeKeyDown } = useRailResize()

  // The reconciler keeps running while the Rail is collapsed (the expanded
  // sidebar variant does not run it).
  useWorktreeReconciler(activeProjectId)

  // Only an expand/collapse animates; a resize follows the pointer.
  const lastExpanded = useRef(expanded)
  const isToggling = lastExpanded.current !== expanded
  useEffect(() => {
    lastExpanded.current = expanded
  }, [expanded])
  const duration = reducedMotion || !isToggling ? 0 : expanded ? 0.2 : 0.15

  const targetWidth = expanded ? width : COLLAPSED_WIDTH

  return (
    <TooltipProvider delayDuration={400}>
      <motion.nav
        aria-label="Projects"
        data-testid="shell-rail"
        data-expanded={expanded}
        data-rail-surface
        className="group/rail relative h-full shrink-0 overflow-hidden bg-sidebar"
        initial={false}
        animate={{ width: targetWidth }}
        transition={{ duration, ease: EASE_OUT }}
      >
        <div className="h-full" style={{ width: targetWidth }}>
          {expanded ? (
            <RailExpanded
              projects={projects}
              activeProjectId={activeProjectId}
              onSelectProject={onSelectProject}
              onNewProject={onNewProject}
              onSSHConnect={onSSHConnect}
              onSelectSSHProfile={onSelectSSHProfile}
              activeSSHProfileId={activeSSHProfileId}
              onOpenCommandPalette={onOpenCommandPalette}
              onOpenCanvas={onOpenCanvas}
              canOpenCanvas={canOpenCanvas}
              isShortcutsOpen={isShortcutsOpen}
              onShortcutsOpenChange={onShortcutsOpenChange}
              isThemePickerOpen={isThemePickerOpen}
              onToggleThemePicker={onToggleThemePicker}
            />
          ) : (
            <RailCollapsed
              projects={projects}
              activeProject={activeProject}
              onSelectProject={onSelectProject}
              onNewProject={onNewProject}
              onOpenCommandPalette={onOpenCommandPalette}
              onOpenCanvas={onOpenCanvas}
              canOpenCanvas={canOpenCanvas}
              onSSHConnect={onSSHConnect}
              onSelectSSHProfile={onSelectSSHProfile}
              activeSSHProfileId={activeSSHProfileId}
            />
          )}
        </div>

        {expanded && (
          <button
            type="button"
            onMouseDown={onResizeMouseDown}
            onKeyDown={onResizeKeyDown}
            className="absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent transition-colors duration-150 ease-out hover:bg-border focus-visible:bg-muted-foreground/40 focus-visible:outline-none active:bg-muted-foreground/40"
            title="Drag to resize"
            aria-label="Resize projects rail"
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={width}
            aria-valuemin={SHELL_LAYOUT_BOUNDS.railWidth.min}
            aria-valuemax={SHELL_LAYOUT_BOUNDS.railWidth.max}
          />
        )}
      </motion.nav>
    </TooltipProvider>
  )
}
