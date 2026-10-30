import { Bug, Edit2, Search, SlidersHorizontal, Workflow } from '@/components/icons'
import { RailColumnIcons } from '@/components/shell/RailColumnIcons'
import { RailUtilityButtons } from '@/components/shell/RailFooter'
import { RailProjectStack } from '@/components/shell/RailProjectStack'
import { RailToggleButton } from '@/components/shell/RailToggleButton'
import { RailButton } from '@/components/shell/rail-button'
import { ShellBrandMark } from '@/components/shell/ShellBrandMark'
import { SSHPopover } from '@/components/shell/SSHPopover'
import { useTopRowPlatform } from '@/components/shell/top-row-context'
import { useTrafficLightInset } from '@/components/shell/traffic-light-inset'
import { useShortcutLabel } from '@/components/shell/use-shortcut-label'
import { cn } from '@/lib/utils'
import { useReportBugStore } from '@/stores/report-bug-store'
import { useSettingsModalStore, useSettingsModalView } from '@/stores/settings-modal-store'
import { useWorkspaceStore } from '@/stores/workspace-store'
import type { Project } from '@/types/project'

interface RailCollapsedProps {
  projects: Project[]
  activeProject: Project | undefined
  onSelectProject: (id: string) => void
  onNewProject: () => void
  onOpenCommandPalette: () => void
  onOpenCanvas: () => void
  canOpenCanvas: boolean
  onSSHConnect: (profileId: string) => void
  onSelectSSHProfile: (profileId: string) => void
  activeSSHProfileId: string | null
  isShortcutsOpen: boolean
  onShortcutsOpenChange: (open: boolean) => void
  isThemePickerOpen: boolean
  onToggleThemePicker?: () => void
}

const NEED_PROJECT = 'Open a project first'

/**
 * Mark / toggle swap: an icon cross-fade on the motion tokens. The hidden icon
 * sits 8px off, at 0.96 and blurred 2px. 250ms both ways. Under reduced motion
 * only the opacity fades.
 */
const SWAP_MOTION = cn(
  'absolute inset-0 flex items-center justify-center',
  'transition-[translate,scale,opacity,filter] duration-[var(--duration-fast)] ease-[ease-in-out]',
  'motion-reduce:translate-x-0! motion-reduce:scale-100! motion-reduce:blur-none! motion-reduce:transition-opacity'
)
/**
 * Hover-in waits 80ms so a pointer that only crosses the Rail does not swap.
 * Hover-out and keyboard focus have no delay.
 */
const HOVER_IN_DELAY = 'group-hover/rail:delay-[var(--duration-micro)]'

/** At rest: shown. On Rail hover or toggle focus: 8px right, 0.96, blurred, faded. */
const MARK_STATES = [
  'group-hover/rail:translate-x-[var(--distance-base)] group-hover/rail:scale-[var(--scale-large)] group-hover/rail:opacity-0 group-hover/rail:blur-[var(--blur-small)]',
  'group-focus-within/swap:translate-x-[var(--distance-base)] group-focus-within/swap:scale-[var(--scale-large)] group-focus-within/swap:opacity-0 group-focus-within/swap:blur-[var(--blur-small)]',
  '[@media(any-hover:none)]:pointer-events-none [@media(any-hover:none)]:opacity-0'
]

/** At rest: 8px left, 0.96, blurred, faded. On Rail hover, toggle focus or no hover input: shown. */
const TOGGLE_STATES = [
  '-translate-x-[var(--distance-base)] scale-[var(--scale-large)] opacity-0 blur-[var(--blur-small)]',
  'group-hover/rail:translate-x-0 group-hover/rail:scale-100 group-hover/rail:opacity-100 group-hover/rail:blur-none',
  'group-focus-within/swap:translate-x-0 group-focus-within/swap:scale-100 group-focus-within/swap:opacity-100 group-focus-within/swap:blur-none',
  '[@media(any-hover:none)]:translate-x-0 [@media(any-hover:none)]:scale-100 [@media(any-hover:none)]:opacity-100 [@media(any-hover:none)]:blur-none'
]

/**
 * The Termul mark and the Rail toggle share one clipped 36px slot. At rest
 * the mark shows and the toggle waits 8px to the left, faded and blurred.
 * While the pointer is over the Rail (`group/rail` on the nav) the two
 * cross-fade after an 80ms intent delay: the toggle comes in left to right
 * and the mark drifts out to the right. Leaving reverses it at once.
 * Keyboard focus on the toggle shows it with no delay.
 *
 * When no connected input can hover (`any-hover: none` — phones, tablets, a
 * laptop in tablet mode) the toggle stays pinned because nothing can trigger
 * the swap. A touchscreen laptop driven by mouse or trackpad keeps the
 * mark-first swap (a finger tap still pops the toggle through sticky
 * tap-hover), and the pinned state drops the mark's pointer events so its
 * invisible drag region never swallows a tap meant for the toggle.
 */
function BrandToggleSwap({ dragRegion }: { dragRegion: boolean }): React.JSX.Element {
  return (
    <div
      className="group/swap relative size-9 shrink-0 overflow-hidden"
      data-testid="rail-brand-swap"
      data-tauri-drag-region={dragRegion ? true : undefined}
    >
      <span
        className={cn(SWAP_MOTION, HOVER_IN_DELAY, MARK_STATES)}
        data-testid="rail-brand-swap-mark"
        data-tauri-drag-region={dragRegion ? true : undefined}
      >
        <ShellBrandMark dragRegion={dragRegion} />
      </span>
      <span
        className={cn(SWAP_MOTION, HOVER_IN_DELAY, TOGGLE_STATES)}
        data-testid="rail-brand-swap-toggle"
      >
        {/* The slot clips at 36px, so the focus ring is drawn inside. */}
        <RailToggleButton className="focus-visible:ring-inset" />
      </span>
    </div>
  )
}

/**
 * Collapsed Rail body (48px): the top band (the 8px window gutter plus the
 * Rail's 40px part of the top row) with the mark / Rail toggle swap, the
 * project stack with status, the Column tab icons (Chats, Explorer, Changes)
 * in a track, Search, Canvas, Automations, SSH, then Theme, Shortcuts and Settings pinned
 * at the bottom.
 */
export function RailCollapsed({
  projects,
  activeProject,
  onSelectProject,
  onNewProject,
  onOpenCommandPalette,
  onOpenCanvas,
  canOpenCanvas,
  onSSHConnect,
  onSelectSSHProfile,
  activeSSHProfileId,
  isShortcutsOpen,
  onShortcutsOpenChange,
  isThemePickerOpen,
  onToggleThemePicker
}: RailCollapsedProps): React.JSX.Element {
  const settingsView = useSettingsModalView()
  const platform = useTopRowPlatform()
  const underTrafficLights = useTrafficLightInset() !== null
  const searchShortcut = useShortcutLabel('commandPalette')
  const settingsShortcut = useShortcutLabel('settings')

  return (
    <div className="flex h-full w-12 shrink-0 flex-col items-center gap-1 pb-2">
      {/* Top row part, drag space. Under the macOS traffic lights it stays
          empty and the mark / toggle swap sits just below it; elsewhere the
          swap sits in it. */}
      <div
        className="flex h-12 w-full shrink-0 items-center justify-center pt-2"
        data-testid="rail-top-band"
        data-tauri-drag-region={platform.dragRegions ? true : undefined}
      >
        {!underTrafficLights && <BrandToggleSwap dragRegion={platform.dragRegions} />}
      </div>
      {underTrafficLights && <BrandToggleSwap dragRegion={platform.dragRegions} />}

      {/* Projects, the Side panel tabs and the actions scroll together on a
          short window; Settings stays pinned at the bottom. */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-3 overflow-y-auto pt-1 scrollbar-hide">
        <RailProjectStack
          projects={projects}
          activeProject={activeProject}
          onSelectProject={onSelectProject}
          onNewProject={onNewProject}
        />

        {/* The Column tabs sit in a track, like the tab bar of the expanded
            Side panel, so they read as tabs and not as actions. */}
        <div
          data-testid="rail-column-tab-track"
          // 10px = the 8px buttons inside + the 2px padding (concentric).
          className="flex flex-col items-center gap-0.5 rounded-[10px] border border-border bg-card p-0.5"
        >
          <RailColumnIcons activeProject={activeProject} />
        </div>

        <div className="flex flex-col items-center gap-1">
          <RailButton
            label="Search"
            hint={searchShortcut}
            aria-label="Search"
            onClick={onOpenCommandPalette}
          >
            <Search size={16} />
          </RailButton>

          <RailButton
            label="Open canvas"
            hint={canOpenCanvas ? undefined : NEED_PROJECT}
            aria-label="Open canvas"
            disabled={!canOpenCanvas}
            onClick={onOpenCanvas}
          >
            <Edit2 size={16} />
          </RailButton>

          <RailButton
            label="Automations"
            hint={activeProject ? undefined : NEED_PROJECT}
            aria-label="Open automations"
            disabled={!activeProject}
            onClick={() =>
              activeProject && useWorkspaceStore.getState().addAutomationsTab(activeProject.id)
            }
          >
            <Workflow size={16} />
          </RailButton>

          {/* Desktop only: renders nothing on web. */}
          <SSHPopover
            onSSHConnect={onSSHConnect}
            onSelectProfile={onSelectSSHProfile}
            activeProfileId={activeSSHProfileId}
          />
        </div>
      </div>

      {/* Theme, Shortcuts, Settings and Report a bug stay pinned at the
          bottom; Settings then Report a bug — the same relative pair order
          as the expanded footer. */}
      <div className="mt-auto flex flex-col items-center gap-1">
        <RailUtilityButtons
          isShortcutsOpen={isShortcutsOpen}
          onShortcutsOpenChange={onShortcutsOpenChange}
          isThemePickerOpen={isThemePickerOpen}
          onToggleThemePicker={onToggleThemePicker}
          size="md"
          className="flex-col gap-1"
        />
        <RailButton
          label="Settings"
          hint={settingsShortcut}
          aria-label="Settings"
          pressed={settingsView === 'app'}
          onClick={() => useSettingsModalStore.getState().openApp()}
        >
          <SlidersHorizontal size={16} />
        </RailButton>
        <RailButton
          label="Report a bug"
          aria-label="Report a bug"
          onClick={() => useReportBugStore.getState().openReport()}
        >
          <Bug size={16} />
        </RailButton>
      </div>
    </div>
  )
}
