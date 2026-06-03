import { Check, Palette, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useUpdateAppSetting } from '@/hooks/use-app-settings'
import { COLOR_THEME_LIST, getColorThemeDefinition } from '@/lib/themes'
import { cn } from '@/lib/utils'
import { useColorTheme } from '@/stores/app-settings-store'
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

  const appliedThemeId = useColorTheme()
  const updateSetting = useUpdateAppSetting()

  const [query, setQuery] = useState('')
  const [focusIndex, setFocusIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const filteredThemes = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return COLOR_THEME_LIST
    return COLOR_THEME_LIST.filter(
      (theme) =>
        theme.name.toLowerCase().includes(normalized) || theme.id.toLowerCase().includes(normalized)
    )
  }, [query])

  const confirmTheme = useCallback(
    async (themeId: string) => {
      await updateSetting('colorTheme', themeId)
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
    const child = list.children[index]
    if (child instanceof HTMLElement) {
      child.scrollIntoView({ block: 'nearest' })
    }
  }, [])

  const wasOpenRef = useRef(false)

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      const highlightedIndex = highlightedThemeId
        ? filteredThemes.findIndex((theme) => theme.id === highlightedThemeId)
        : 0
      setFocusIndex(highlightedIndex >= 0 ? highlightedIndex : 0)
    }
    wasOpenRef.current = isOpen

    if (!isOpen) return
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [filteredThemes, highlightedThemeId, isOpen])

  useEffect(() => {
    if (!isOpen) return
    scrollFocusedIntoView(focusIndex)
  }, [focusIndex, isOpen, scrollFocusedIntoView])

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
        const next = Math.min(focusIndex + 1, filteredThemes.length - 1)
        setFocusIndex(next)
        const theme = filteredThemes[next]
        if (theme) preview(theme.id)
        scrollFocusedIntoView(next)
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        const next = Math.max(focusIndex - 1, 0)
        setFocusIndex(next)
        const theme = filteredThemes[next]
        if (theme) preview(theme.id)
        scrollFocusedIntoView(next)
        return
      }

      if (event.key === 'Enter') {
        event.preventDefault()
        const themeId = highlightedThemeId ?? filteredThemes[focusIndex]?.id
        if (themeId) {
          void confirmTheme(themeId)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [
    confirmTheme,
    filteredThemes,
    focusIndex,
    handleCancel,
    highlightedThemeId,
    isOpen,
    preview,
    scrollFocusedIntoView
  ])

  useEffect(() => {
    if (focusIndex >= filteredThemes.length) {
      setFocusIndex(Math.max(0, filteredThemes.length - 1))
    }
  }, [filteredThemes.length, focusIndex])

  if (!isOpen) return null

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
        className="pointer-events-auto absolute right-4 bottom-4 top-4 w-[min(20rem,calc(100vw-2rem))] flex flex-col rounded-xl border border-border bg-popover/95 shadow-2xl backdrop-blur-sm"
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
          {filteredThemes.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">No themes match.</p>
          ) : (
            filteredThemes.map((theme, index) => {
              const isApplied = theme.id === appliedThemeId
              const isHighlighted =
                theme.id === highlightedThemeId ||
                (highlightedThemeId === null && index === focusIndex)
              const isFocused = index === focusIndex

              return (
                <button
                  key={theme.id}
                  type="button"
                  role="option"
                  aria-selected={isHighlighted}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors duration-100 ease-[var(--ease-out)] active:scale-[0.98]',
                    isHighlighted || isFocused
                      ? 'bg-accent/20 text-foreground'
                      : 'text-foreground/90 hover:bg-secondary/80'
                  )}
                  onMouseEnter={() => {
                    setFocusIndex(index)
                    preview(theme.id)
                  }}
                  onFocus={() => {
                    setFocusIndex(index)
                    preview(theme.id)
                  }}
                  onClick={() => {
                    void confirmTheme(theme.id)
                  }}
                >
                  <ThemeSwatches themeId={theme.id} />
                  <span className="flex-1 truncate font-medium">{theme.name}</span>
                  {isApplied ? (
                    <Check
                      size={14}
                      className="text-primary shrink-0"
                      aria-label="Currently applied"
                    />
                  ) : null}
                </button>
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
