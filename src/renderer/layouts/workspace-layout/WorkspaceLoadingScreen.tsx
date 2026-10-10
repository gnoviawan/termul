import { ActivityRail } from '@/components/ActivityRail'
import { ResizeEdges } from '@/components/ResizeEdges'
import { TitleBar } from '@/components/TitleBar'
import { MacOsTitlebarStrip } from '@/layouts/workspace-layout/MacOsTitlebarStrip'

interface WorkspaceLoadingScreenProps {
  isMobileWebShell: boolean
  isShortcutMenuOpen: boolean
  setIsShortcutMenuOpen: (open: boolean) => void
  setIsCommandPaletteOpen: (open: boolean) => void
}

/** The "Loading..." state shown while projects are being loaded (mobile and desktop). */
export function WorkspaceLoadingScreen({
  isMobileWebShell,
  isShortcutMenuOpen,
  setIsShortcutMenuOpen,
  setIsCommandPaletteOpen
}: WorkspaceLoadingScreenProps): React.JSX.Element {
  if (isMobileWebShell) {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        <div className="flex flex-1 items-center justify-center">
          <div className="text-sm text-muted-foreground">Loading...</div>
        </div>
      </div>
    )
  }
  return (
    <div className="h-screen flex flex-col overflow-hidden bg-background">
      <ResizeEdges />
      <div className="flex-1 flex flex-col overflow-hidden min-h-0 h-full">
        <MacOsTitlebarStrip />
        <div className="flex-1 flex overflow-hidden min-h-0">
          <ActivityRail
            isShortcutsOpen={isShortcutMenuOpen}
            onShortcutsOpenChange={setIsShortcutMenuOpen}
            onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
            canOpenGitChanges={false}
          />
          <div className="flex-1 flex flex-col min-w-0">
            <TitleBar />
            <div className="flex-1 flex items-center justify-center">
              <div className="text-muted-foreground text-sm">Loading...</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
