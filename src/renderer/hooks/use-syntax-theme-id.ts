import { useEffect, useState } from 'react'
import { getLastAppliedColorThemeId } from '@/lib/themes/apply-color-theme'
import { COLOR_THEME_CHANGED_EVENT, type ColorThemeChangedDetail } from '@/lib/themes/types'

/** Active color theme id. Code blocks re-highlight when this changes. */
export function useSyntaxThemeId(): string {
  const [themeId, setThemeId] = useState(getLastAppliedColorThemeId)

  useEffect(() => {
    const onChange = (event: Event): void => {
      const detail = (event as CustomEvent<ColorThemeChangedDetail>).detail
      if (detail?.themeId) setThemeId(detail.themeId)
    }
    window.addEventListener(COLOR_THEME_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(COLOR_THEME_CHANGED_EVENT, onChange)
  }, [])

  return themeId
}
