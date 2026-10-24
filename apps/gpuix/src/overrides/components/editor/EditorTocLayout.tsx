/**
 * GPUIX twin of `components/editor/EditorTocLayout.tsx`. The web lays the
 * editor and its outline in a `react-resizable-panels` group, which measures
 * DOM panels and throws ("Invalid 0 panel layout") when none register. Here
 * the outline is a fixed-width column at the stored TOC width (no drag
 * handle), or the tick strip in a pane under 720px, with the web's rules for
 * which one shows.
 */

import type { EventPayload } from '@gpuix/react'
import { useState } from 'react'
import { useShallow } from 'zustand/shallow'
import type { TocVariant } from '@/components/editor/TocPanel'
import { useMobileWebShell } from '@/hooks/use-mobile-web-shell'
import { useTocSettingsStore } from '@/stores/toc-settings-store'
import { TOC_MAX_WIDTH, TOC_MIN_WIDTH, TOC_NARROW_PANE_WIDTH } from '@/types/settings'
import { tw } from '../../../style/tw'

interface EditorTocLayoutProps {
  isVisible: boolean
  hasOutline?: boolean
  children: React.ReactNode
  renderOutline: (variant: TocVariant) => React.ReactNode
}

const HIDDEN = {
  position: 'absolute',
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  opacity: 0,
  overflow: 'hidden'
} as const

export function EditorTocLayout({
  isVisible,
  hasOutline = true,
  children,
  renderOutline
}: EditorTocLayoutProps): React.JSX.Element {
  const [width, setWidth] = useState(0)
  const { isTocHydrated, isTocVisible, tocWidth } = useTocSettingsStore(
    useShallow((state) => ({
      isTocHydrated: state.isLoaded || state.loadFailed,
      isTocVisible: state.settings.isVisible,
      tocWidth: state.settings.width
    }))
  )
  const isMobileWebShell = useMobileWebShell()
  const isNarrowPane = width > 0 && width < TOC_NARROW_PANE_WIDTH
  const variant: TocVariant | null =
    hasOutline && isTocHydrated && isTocVisible
      ? isMobileWebShell || isNarrowPane
        ? 'strip'
        : 'panel'
      : null
  const panelWidth = Math.min(TOC_MAX_WIDTH, Math.max(TOC_MIN_WIDTH, tocWidth))

  return (
    <div
      style={isVisible ? tw('h-full w-full') : HIDDEN}
      onLayout={(event: EventPayload) => setWidth(event.width ?? 0)}
    >
      <div style={tw('flex h-full w-full')}>
        <div style={tw('flex h-full min-w-0 flex-1')}>
          {children}
          {variant === 'strip' ? renderOutline('strip') : null}
        </div>
        {variant === 'panel' ? (
          <div style={{ ...tw('h-full border-l border-border'), width: panelWidth, flexShrink: 0 }}>
            {renderOutline('panel')}
          </div>
        ) : null}
      </div>
    </div>
  )
}
