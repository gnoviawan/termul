import { Check, Palette, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUpdateAppSetting } from '@/hooks/use-app-settings'
import { useEffectiveColorThemeId } from '@/hooks/use-color-theme'
import {
  COLOR_THEME_FAMILIES,
  getColorThemeDefinition,
  getPickerApplySettings,
  THEME_PICKER_ROWS,
  type ThemePickerRow
} from '@/lib/themes'
import { cn } from '@/lib/utils'
import { useThemePickerStore } from '@/stores/theme-picker-store'

function ThemeSwatches({ themeId }: { themeId: string }): React.JSX.Element {
  const palette = getColorThemeDefinition(themeId).dark.palette
  const colors = [palette.neutral, palette.primary, palette.accent, palette.success]

  return (
    <span className="flex items-center gap-0.5 shrink-0" aria-hidden="true">
      {colors.map((color) => (
        <span
          key={`${themeId}-${color}`}
          className="h-2.5 w-2.5 rounded-full border border-border/60"
          style={{ backgroundColor: color }}
        />
      ))}
    </span>
  )
}

export function ThemePicker(): React.JSX.Element | null {
  const isOpen = useThemePickerStore((state) => state.isOpen)
  const highlightedThemeId = useThemePickerStore((state) => state.highlightedThemeId)
  const preview = useThemePickerStore((state) => state.preview)
  const cancel = useThemePickerStore((state) => state.cancel)
  const close = useThemePickerStore((state) => state.close)

  const effectiveThemeId = useEffectiveColorThemeId()
  const updateSetting = useUpdateAppSetting()

  const [query, setQuery] = useState('')
  const [focusIndex, setFocusIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const previousQueryRef = useRef(query)

  const filteredRows = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return THEME_PICKER_ROWS
    return THEME_PICKER_ROWS.filter(
      (row) =>
        row.label.toLowerCase().includes(normalized) ||
        row.familyId.toLowerCase().includes(normalized) ||
        row.themeId.toLowerCase().includes(normalized)
    )
  }, [query])

  const filteredFamilies = useMemo(() => {
    const familyIds = new Set(filteredRows.map((row) => row.familyId))
    return COLOR_THEME_FAMILIES.filter((family) => familyIds.has(family.familyId))
  }, [filteredRows])

  const flatFilteredRows = useMemo(() => {
    return filteredFamilies.flatMap((family) =>
      filteredRows.filter((row) => row.familyId === family.familyId)
    )
  }, [filteredFamilies, filteredRows])

  const confirmRow = useCallback(
    async (row: ThemePickerRow) => {
      const apply = getPickerApplySettings(row.themeId)
      await updateSetting('colorTheme', apply.colorTheme)
      await updateSetting('appearanceMode', apply.appearanceMode)
      close()
      setQuery('')
    },
    [close, updateSetting]
  )

  const handleCancel = useCallback(() => {
    cancel()
    setQuery('')
  }, [cancel])

  const scrollFocusedIntoView = useCallback((index: number) => {
    const list = listRef.current
    if (!list) return
    const options = list.querySelectorAll<HTMLElement>('[data-theme-row]')
    const child = options[index]
    child?.scrollIntoView({ block: 'nearest' })
  }, [])

  const wasOpenRef = useRef(false)

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      const highlightedIndex = highlightedThemeId
        ? flatFilteredRows.findIndex((row) => row.themeId === highlightedThemeId)
        : 0
      setFocusIndex(highlightedIndex >= 0 ? highlightedIndex : 0)
    }
    wasOpenRef.current = isOpen

    if (!isOpen) return
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [flatFilteredRows, highlightedThemeId, isOpen])

  useEffect(() => {
    if (!isOpen) return
    scrollFocusedIntoView(focusIndex)
  }, [focusIndex, isOpen, scrollFocusedIntoView])

  useEffect(() => {
    if (!isOpen) {
      previousQueryRef.current = query
      return
    }

    if (previousQueryRef.current === query) return
    previousQueryRef.current = query

    const row = flatFilteredRows[0]
    if (row) {
      setFocusIndex(0)
      preview(row.themeId)
    }
  }, [flatFilteredRows, isOpen, preview, query])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        handleCancel()
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const next = Math.min(focusIndex + 1, flatFilteredRows.length - 1)
        setFocusIndex(next)
        const row = flatFilteredRows[next]
        if (row) preview(row.themeId)
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        const next = Math.max(focusIndex - 1, 0)
        setFocusIndex(next)
        const row = flatFilteredRows[next]
        if (row) preview(row.themeId)
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        const row =
          flatFilteredRows[focusIndex] ??
          flatFilteredRows.find((item) => item.themeId === highlightedThemeId)
        if (row) {
          void confirmRow(row)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [confirmRow, flatFilteredRows, focusIndex, handleCancel, highlightedThemeId, isOpen, preview])

  useEffect(() => {
    if (focusIndex >= flatFilteredRows.length) {
      setFocusIndex(Math.max(0, flatFilteredRows.length - 1))
    }
  }, [flatFilteredRows.length, focusIndex])

  if (!isOpen) return null

  let rowCounter = 0

  return (
    <div className="fixed inset-0 z-[120] pointer-events-none">
      <div
        className="absolute inset-0 pointer-events-auto"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            handleCancel()
          }
        }}
        aria-hidden="true"
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-label="Color theme picker"
        className="pointer-events-auto absolute left-14 top-4 bottom-4 w-[min(20rem,calc(100vw-2rem))] flex flex-col rounded-xl border border-border bg-popover/95 shadow-2xl backdrop-blur-sm"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Palette size={16} className="text-primary shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-foreground leading-none">Color Themes</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Hover to preview · Enter to apply
            </p>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors duration-150 ease-[var(--ease-out)] active:scale-[0.97]"
            aria-label="Close theme picker"
          >
            <X size={14} />
          </button>
        </header>

        <div className="px-3 py-2 border-b border-border">
          <div className="relative">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setFocusIndex(0)
              }}
              placeholder="Search themes…"
              className="w-full rounded-md border border-border bg-secondary/50 py-1.5 pl-8 pr-3 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:ring-2 focus:ring-primary/40"
              aria-label="Search themes"
            />
          </div>
        </div>

        <div
          ref={listRef}
          className="flex-1 overflow-y-auto p-2"
          role="listbox"
          aria-label="Themes"
        >
          {filteredFamilies.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">No themes match.</p>
          ) : (
            filteredFamilies.map((family) => {
              const rows = filteredRows.filter((row) => row.familyId === family.familyId)
              return (
                <div key={family.familyId} className="mb-3 last:mb-0">
                  <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {family.name}
                  </p>
                  {rows.map((row) => {
                    const index = rowCounter
                    rowCounter += 1
                    const isApplied = row.themeId === effectiveThemeId
                    const isHighlighted =
                      row.themeId === highlightedThemeId ||
                      (highlightedThemeId === null && index === focusIndex)
                    const isFocused = index === focusIndex

                    return (
                      <button
                        key={row.themeId}
                        type="button"
                        role="option"
                        data-theme-row
                        aria-selected={isHighlighted}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors duration-100 ease-[var(--ease-out)] active:scale-[0.98]',
                          isHighlighted || isFocused
                            ? 'bg-accent/20 text-foreground'
                            : 'text-foreground/90 hover:bg-secondary/80'
                        )}
                        onMouseEnter={() => {
                          setFocusIndex(index)
                          preview(row.themeId)
                        }}
                        onFocus={() => {
                          setFocusIndex(index)
                          preview(row.themeId)
                        }}
                        onClick={() => {
                          void confirmRow(row)
                        }}
                      >
                        <ThemeSwatches themeId={row.themeId} />
                        <span className="flex-1 truncate font-medium">{row.label}</span>
                        {isApplied ? (
                          <Check
                            size={14}
                            className="text-primary shrink-0"
                            aria-label="Currently applied"
                          />
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              )
            })
          )}
        </div>

        <footer className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          Esc cancel · Enter apply
        </footer>
      </section>
    </div>
  )
}
