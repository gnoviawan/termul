import { Edit2, Search, SlidersHorizontal } from '@/components/icons'
import { RailColumnIcons } from '@/components/shell/RailColumnIcons'
import { RailProjectStack } from '@/components/shell/RailProjectStack'
import { RailToggleButton } from '@/components/shell/RailToggleButton'
import { RailButton } from '@/components/shell/rail-button'
import { ShellBrandMark } from '@/components/shell/ShellBrandMark'
import { SSHPopover } from '@/components/shell/SSHPopover'
import { useTopRowPlatform } from '@/components/shell/top-row-context'
import { useTrafficLightInset } from '@/components/shell/traffic-light-inset'
import { useShortcutLabel } from '@/components/shell/use-shortcut-label'
import { cn } from '@/lib/utils'
import { useSettingsModalStore, useSettingsModalView } from '@/stores/settings-modal-store'
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
}

const NEED_PROJECT = 'Open a project first'

/** Shared slide of the mark / toggle swap: instant under reduced motion. */
const SWAP_MOTION =
  'absolute inset-0 flex items-center justify-center transition-[translate,opacity] duration-[220ms] ease-out motion-reduce:transition-none'

/**
 * The Termul mark and the Rail toggle share one clipped 36px slot. At rest
 * the mark shows and the toggle waits off to the left, transparent. While
 * the pointer is over the Rail (`group/rail` on the nav) the toggle slides
 * in left to right and the mark slides out to the right; leaving reverses
 * it. Keyboard focus on the toggle shows it too. The slide takes 220ms.
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
        className={cn(
          SWAP_MOTION,
          'group-hover/rail:translate-x-full group-hover/rail:opacity-0',
          'group-focus-within/swap:translate-x-full group-focus-within/swap:opacity-0',
          '[@media(any-hover:none)]:pointer-events-none [@media(any-hover:none)]:opacity-0'
        )}
        data-testid="rail-brand-swap-mark"
        data-tauri-drag-region={dragRegion ? true : undefined}
      >
        <ShellBrandMark dragRegion={dragRegion} />
      </span>
      <span
        className={cn(
          SWAP_MOTION,
          '-translate-x-full opacity-0',
          'group-hover/rail:translate-x-0 group-hover/rail:opacity-100',
          'group-focus-within/swap:translate-x-0 group-focus-within/swap:opacity-100',
          '[@media(any-hover:none)]:translate-x-0 [@media(any-hover:none)]:opacity-100'
        )}
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
 * in a track, Search, Canvas, SSH, then Settings pinned at the bottom. No
 * Theme or Shortcuts buttons here.
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
  activeSSHProfileId
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

          {/* Desktop only: renders nothing on web. */}
          <SSHPopover
            onSSHConnect={onSSHConnect}
            onSelectProfile={onSelectSSHProfile}
            activeProfileId={activeSSHProfileId}
          />
        </div>
      </div>

      {/* Settings stays pinned at the bottom. */}
      <div className="mt-auto flex flex-col items-center gap-1">
        <RailButton
          label="Settings"
          hint={settingsShortcut}
          aria-label="Settings"
          pressed={settingsView === 'app'}
          onClick={() => useSettingsModalStore.getState().openApp()}
        >
          <SlidersHorizontal size={16} />
        </RailButton>
      </div>
    </div>
  )
}
