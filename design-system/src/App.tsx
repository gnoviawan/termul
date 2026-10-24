import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  applyColorTheme,
  BUNDLED_COLOR_THEMES,
  DEFAULT_COLOR_THEME_ID,
  THEME_PICKER_ROWS
} from '@/lib/themes'
import { Canvas } from './canvas/Canvas'
import type { Camera, Point } from './canvas/camera'
import { loadLayout, type SavedLayout, saveLayout } from './canvas/layout-storage'
import { SECTIONS } from './registry'
import { layoutSections } from './registry/layout'

const SAVE_DELAY_MS = 400

function isBundledTheme(id: string): boolean {
  return Object.hasOwn(BUNDLED_COLOR_THEMES, id)
}

const DARK_ROWS = THEME_PICKER_ROWS.filter((row) => row.variant === 'dark')
const LIGHT_ROWS = THEME_PICKER_ROWS.filter((row) => row.variant === 'light')

export function App() {
  const layout = useMemo(() => layoutSections(SECTIONS), [])
  const validIds = useMemo(() => new Set(layout.entries.map((entry) => entry.id)), [layout])
  const [initial] = useState<SavedLayout>(() => loadLayout(validIds, isBundledTheme))
  const [themeId, setThemeId] = useState(initial.themeId ?? DEFAULT_COLOR_THEME_ID)
  const [positions, setPositions] = useState<Record<string, Point>>(initial.positions)
  const [canvasKey, setCanvasKey] = useState(0)

  // Latest layout snapshot for debounced and pagehide saves.
  const snapshot = useRef<SavedLayout>(initial)
  const saveTimer = useRef<number | undefined>(undefined)

  const flush = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    saveLayout(snapshot.current)
  }, [])

  const scheduleSave = useCallback(() => {
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(flush, SAVE_DELAY_MS)
  }, [flush])

  useLayoutEffect(() => {
    applyColorTheme(themeId)
    snapshot.current = { ...snapshot.current, themeId }
    scheduleSave()
  }, [themeId, scheduleSave])

  useEffect(() => {
    const onPageHide = () => flush()
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      flush()
    }
  }, [flush])

  const onMove = useCallback(
    (id: string, position: Point) => {
      // The ref is the source of truth for saves; update it before React state.
      const next = { ...snapshot.current.positions, [id]: position }
      snapshot.current = { ...snapshot.current, positions: next }
      setPositions(next)
      scheduleSave()
    },
    [scheduleSave]
  )

  // Every camera change lands in the snapshot at once, so pagehide never saves a stale camera.
  const onCameraChange = useCallback((camera: Camera) => {
    snapshot.current = { ...snapshot.current, camera }
  }, [])

  const onCameraSettled = useCallback(
    (camera: Camera) => {
      snapshot.current = { ...snapshot.current, camera }
      scheduleSave()
    },
    [scheduleSave]
  )

  const onResetLayout = useCallback(() => {
    snapshot.current = { camera: null, themeId: snapshot.current.themeId, positions: {} }
    setPositions({})
    flush()
    // Remount the canvas so it fits the default layout from scratch.
    setCanvasKey((key) => key + 1)
  }, [flush])

  const themeControl = (
    <Select value={themeId} onValueChange={setThemeId}>
      <SelectTrigger
        aria-label="Color theme"
        className="h-8 w-32 min-w-0 cursor-default text-xs sm:w-44"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="end" className="max-h-[70vh]">
        <SelectGroup>
          <SelectLabel>Dark</SelectLabel>
          {DARK_ROWS.map((row) => (
            <SelectItem key={row.themeId} value={row.themeId}>
              {row.label}
            </SelectItem>
          ))}
        </SelectGroup>
        <SelectSeparator />
        <SelectGroup>
          <SelectLabel>Light</SelectLabel>
          {LIGHT_ROWS.map((row) => (
            <SelectItem key={row.themeId} value={row.themeId}>
              {row.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )

  return (
    <Canvas
      key={canvasKey}
      layout={layout}
      sections={SECTIONS.map(({ id, title }) => ({ id, title }))}
      positions={positions}
      initialCamera={canvasKey === 0 ? initial.camera : null}
      themeControl={themeControl}
      onMove={onMove}
      onCameraChange={onCameraChange}
      onCameraSettled={onCameraSettled}
      onResetLayout={onResetLayout}
    />
  )
}
