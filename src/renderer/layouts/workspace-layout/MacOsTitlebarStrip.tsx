import {
  FileExplorerToggleButton,
  SidebarToggleButton,
  TitleStripTitle,
  titlebarNoDragStyle
} from '@/components/TitlebarPanelToggles'
import { isMac, macOsTitlebarStripClass } from '@/lib/platform'
import { isTauriContext } from '@/lib/tauri-runtime'

/**
 * Width of the draggable spacer that clears the macOS native traffic lights
 * (tauri.conf.json trafficLightPosition x=14; three ~12px lights ~8px apart
 * end near x=66). The spacer is its own drag handle so the clearance area
 * stays a window-drag zone; the toggle sits in a separate no-drag container.
 */
const macOsTrafficLightClearance = 'w-[80px] shrink-0'

export function MacOsTitlebarStrip(): React.JSX.Element | null {
  // macOS desktop only — native traffic lights + drag region. Web (even on
  // a Mac browser) falls through to the web TitleBar path instead.
  if (!isMac || !isTauriContext()) return null

  return (
    <div
      className={macOsTitlebarStripClass}
      data-tauri-drag-region
      data-testid="macos-titlebar-strip"
    >
      {/* Draggable spacer clearing the native traffic lights so the area
          left of the sidebar toggle stays a window-drag handle. */}
      <div className={`h-full ${macOsTrafficLightClearance}`} data-tauri-drag-region />

      {/* Left-sidebar toggle — no-drag, sits right of the traffic lights. */}
      <div className="flex items-center h-full" style={titlebarNoDragStyle}>
        <SidebarToggleButton />
      </div>

      <TitleStripTitle />

      <div className="flex-1 h-full" data-tauri-drag-region />

      {/* Right-sidebar (file explorer) toggle — top-right. */}
      <div className="flex items-center h-full" style={titlebarNoDragStyle}>
        <FileExplorerToggleButton />
      </div>
    </div>
  )
}
