/**
 * The What's New release notes as native markdown. The web renders them to
 * sanitized HTML for `dangerouslySetInnerHTML`, which compat cannot paint.
 * The metrics follow `.chat-prose text-xs leading-relaxed` (index.css):
 * 12px text on a 19.5px line, headings at 1.25/1.1/1em on a 1.3 line, and
 * list markers in muted-foreground/70.
 */

import type { GpuixTheme } from '@gpuix/react'
import { useColorTheme } from '@/stores/app-settings-store'
import { tokenColor, transcriptThemes } from '../../chat/theme'
import { tw } from '../../style/tw'

function notesTheme(themeId: string): GpuixTheme {
  const { prose } = transcriptThemes(themeId)
  return {
    ...prose,
    accent: tokenColor('muted-foreground/70'),
    metrics: {
      ...prose.metrics,
      mdTextSize: 12,
      mdLineHeight: 19.5,
      mdBlockGap: 8.4,
      mdHeadingSizes: [15, 13.2, 12, 12],
      mdHeadingLineHeights: [19.5, 17.2, 15.6, 15.6]
    }
  }
}

export function WhatsNewNotes({ notes }: { notes: string | null }) {
  const theme = notesTheme(useColorTheme())
  return (
    <div style={{ ...tw('flex max-h-[320px] flex-col pr-1'), overflowY: 'scroll' }}>
      {notes ? (
        <markdown source={notes} theme={theme} style={{ flexShrink: 0, minWidth: 0 }} />
      ) : (
        <text style={tw('text-xs text-muted-foreground leading-relaxed')}>
          Release notes aren't available for this version.
        </text>
      )}
    </div>
  )
}
