/**
 * A GFM task-list item as Streamdown shows it: the list marker, then a
 * disabled `<input type="checkbox">`, then the item's text. Native markdown
 * prints `[x]` literally and has no inline elements, so the item is laid out
 * here: the marker and the box are painted, the text is its own `<markdown>`.
 *
 * Geometry is measured from Chromium at 14px prose (chat.transcript, M2
 * frames), relative to the item's left edge: the disc ink spans 0..4 px,
 * the 13px box starts at 20 px, the text box at 37 px, and the box's top sits
 * 3 px above the cap height.
 */

import type { ReactNode } from 'react'
import { getColorThemeDefinition } from '@/lib/themes/bundled-themes'
import { normalizeThemeFamilyId } from '@/lib/themes/theme-appearance'
import type { TaskMarker } from './prose-source'
import { tokenColor } from './theme'

/**
 * Chromium's disabled checkbox in each colour scheme (the web shows the user
 * agent's control, not a Termul token). Dark is measured from the M2 frames;
 * light follows Chromium's light palette and is not measured.
 */
const BOX = {
  dark: {
    checked: { fill: 'rgb(117, 117, 117)', border: 'rgb(117, 117, 117)', mark: 'rgb(59, 59, 59)' },
    unchecked: { fill: 'rgb(59, 59, 59)', border: 'rgb(98, 98, 98)', mark: '' }
  },
  light: {
    checked: {
      fill: 'rgb(198, 198, 198)',
      border: 'rgb(198, 198, 198)',
      mark: 'rgb(255, 255, 255)'
    },
    unchecked: { fill: 'rgb(255, 255, 255)', border: 'rgb(198, 198, 198)', mark: '' }
  }
} as const

const CHECK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 13 13"><path d="M2.6 6.6 4.9 8.9 9.8 2.6" fill="none" stroke="#000" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** Cap top of the first prose line (14px Inter on a 21px line), from the item's top. */
const CAP_TOP = 6
const BOX_SIZE = 13
const BOX_LEFT = 20
const TEXT_LEFT = 37
const DISC = 5

export function TaskItem({
  task,
  themeId,
  children
}: {
  task: TaskMarker
  themeId: string
  children: ReactNode
}) {
  const scheme =
    getColorThemeDefinition(normalizeThemeFamilyId(themeId)).appearance === 'light'
      ? 'light'
      : 'dark'
  const colors = BOX[scheme][task.checked ? 'checked' : 'unchecked']
  const ordered = /\d/.test(task.marker)
  return (
    <div style={{ display: 'flex', flexDirection: 'row', minWidth: 0, position: 'relative' }}>
      {ordered ? (
        <text
          style={{
            position: 'absolute',
            right: '100%',
            top: 0,
            marginRight: -BOX_LEFT + 6,
            fontSize: 14,
            lineHeight: 21,
            color: tokenColor('foreground')
          }}
        >
          {task.marker}
        </text>
      ) : (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: CAP_TOP + 3,
            width: DISC,
            height: DISC,
            borderRadius: DISC / 2,
            backgroundColor: tokenColor('foreground')
          }}
        />
      )}
      <div
        testId="chat-task-box"
        style={{
          position: 'absolute',
          left: BOX_LEFT,
          top: CAP_TOP - 3,
          width: BOX_SIZE,
          height: BOX_SIZE,
          borderRadius: 2.5,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.fill
        }}
      >
        {task.checked ? (
          <svg
            source={CHECK_SVG}
            style={{
              position: 'absolute',
              left: -1,
              top: -1,
              width: BOX_SIZE,
              height: BOX_SIZE,
              color: colors.mark
            }}
          />
        ) : null}
      </div>
      <div style={{ marginLeft: TEXT_LEFT, minWidth: 0, flexGrow: 1, flexShrink: 1 }}>
        {children}
      </div>
    </div>
  )
}
