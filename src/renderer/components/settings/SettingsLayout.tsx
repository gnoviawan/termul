import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from '@/components/icons'
import {
  FOCUS_RING_CLASS,
  PANEL_FIELD_CLASS,
  PANEL_FIELD_ICON_CLASS,
  QUIET_ICON_BUTTON_CLASS
} from '@/components/ui/panel-styles'
import { type SettingsSearchEntry, searchSettings } from '@/lib/settings-search'
import { cn } from '@/lib/utils'

/** A settings category shown in the left sidebar. */
export interface SettingsCategory {
  /** Stable id; also used as the scroll anchor target (`data-settings-section`). */
  id: string
  /** Sidebar label. */
  label: string
  /** Optional icon rendered before the label. */
  icon?: React.ReactNode
}

interface SettingsLayoutProps {
  /** Categories to render in the sidebar, in display order. */
  categories: SettingsCategory[]
  /** Flat search index across every category. */
  searchIndex: readonly SettingsSearchEntry[]
  /**
   * Section content. Each section must be wrapped so its root carries
   * `data-settings-section="<categoryId>"` — use {@link SettingsSection}.
   */
  children: React.ReactNode
  /** Optional extra content rendered at the bottom of the sidebar. */
  sidebarFooter?: React.ReactNode
  /** Sidebar header label (`.label-panel`). */
  title: string
}

/** Category ids set apart at the end of the list with a top hairline. */
const SET_APART_CATEGORY_IDS = new Set(['reset'])

const ROW_CLASS = `flex flex-shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left text-xs transition-colors duration-150 ease-out md:w-full ${FOCUS_RING_CLASS}`

/**
 * Wrapper for a single settings section. Tags the section with its category id
 * so {@link SettingsLayout} can scroll to it and track the active category via
 * scroll-spy. The `id` doubles as a stable DOM id (`settings-section-<id>`) for
 * anchor-based navigation.
 */
export function SettingsSection({
  id,
  children,
  className
}: {
  id: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section
      id={`settings-section-${id}`}
      data-settings-section={id}
      className={cn('scroll-mt-4', className)}
    >
      {children}
    </section>
  )
}

/**
 * Shared settings shell: a left sidebar listing categories with the active one
 * highlighted, a fuzzy search box, and a scrollable content area. Clicking a
 * category (or selecting a search result) scrolls the matching section into
 * view; scroll-spy keeps the active category in sync while the user scrolls.
 *
 * The content remains a single scrollable column (scroll-spy navigation rather
 * than show-one-at-a-time) so the existing save bar and unsaved-changes guard
 * in ProjectSettings keep working unchanged.
 */
export function SettingsLayout({
  categories,
  searchIndex,
  children,
  sidebarFooter,
  title
}: SettingsLayoutProps): React.JSX.Element {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [activeId, setActiveId] = useState<string | undefined>(categories[0]?.id)
  const [query, setQuery] = useState('')
  // While a programmatic scroll is in flight, suppress scroll-spy so the active
  // highlight follows the click target rather than intermediate sections.
  const programmaticScrollRef = useRef(false)
  const programmaticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const results = useMemo(() => searchSettings(query, searchIndex), [query, searchIndex])
  const isSearching = query.trim().length > 0

  const scrollToSection = useCallback((id: string, anchorId?: string) => {
    const root = contentRef.current
    if (!root) return

    const target =
      (anchorId && root.querySelector<HTMLElement>(`#${CSS.escape(anchorId)}`)) ||
      root.querySelector<HTMLElement>(`[data-settings-section="${CSS.escape(id)}"]`)
    if (!target) return

    programmaticScrollRef.current = true
    if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current)
    programmaticTimerRef.current = setTimeout(() => {
      programmaticScrollRef.current = false
    }, 600)

    setActiveId(id)
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // Scroll-spy: highlight the section nearest the top of the viewport.
  useEffect(() => {
    const root = contentRef.current
    if (!root || categories.length === 0) return

    const sections = Array.from(root.querySelectorAll<HTMLElement>('[data-settings-section]'))
    if (sections.length === 0) return

    const visible = new Map<string, number>()

    const recompute = (): void => {
      if (programmaticScrollRef.current) return
      let topId: string | undefined
      let bestDistance = Number.POSITIVE_INFINITY
      // Pick the section whose top edge is closest to the viewport top (0),
      // not the smallest raw value — sections scrolled past have large negative
      // tops while still intersecting, and must not stay active.
      for (const [id, top] of visible) {
        const distance = Math.abs(top)
        if (distance < bestDistance) {
          bestDistance = distance
          topId = id
        }
      }
      if (topId) setActiveId(topId)
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.settingsSection
          if (!id) continue
          if (entry.isIntersecting) {
            visible.set(id, entry.boundingClientRect.top)
          } else {
            visible.delete(id)
          }
        }
        recompute()
      },
      {
        root,
        threshold: [0, 0.1, 0.5],
        rootMargin: '0px 0px -70% 0px'
      }
    )

    for (const section of sections) observer.observe(section)

    return () => {
      observer.disconnect()
      visible.clear()
    }
    // Re-run when the set of categories changes (sections added/removed).
  }, [categories])

  useEffect(() => {
    return () => {
      if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current)
    }
  }, [])

  const handleCategoryKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const dir = event.key === 'ArrowDown' ? 1 : -1
      const next = (index + dir + categories.length) % categories.length
      const sidebar = event.currentTarget.parentElement
      const buttons = sidebar?.querySelectorAll<HTMLButtonElement>('[data-category-button]')
      buttons?.[next]?.focus()
    }
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col overflow-hidden md:flex-row">
      {/* Sidebar — top bar on mobile, left sidebar on desktop */}
      <aside className="flex flex-shrink-0 flex-col border-b border-border bg-background md:w-60 md:border-b-0 md:border-r">
        <div className="hidden h-10 items-center pl-4 md:flex">
          <span className="label-panel truncate">{title}</span>
        </div>
        <div className="px-2 pb-2 pt-2 md:pt-0">
          <div className="relative">
            <Search size={13} aria-hidden className={PANEL_FIELD_ICON_CLASS} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings"
              aria-label="Search settings"
              className={cn(PANEL_FIELD_CLASS, 'h-8 w-full pl-7 pr-7')}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className={cn(
                  QUIET_ICON_BUTTON_CLASS,
                  'absolute right-1 top-1/2 flex size-6 -translate-y-1/2'
                )}
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        <nav
          aria-label="Settings categories"
          className="flex flex-1 gap-0.5 overflow-x-auto px-2 pb-2 md:flex-col md:overflow-y-auto"
        >
          {isSearching ? (
            results.length === 0 ? (
              <p className="px-2.5 py-4 text-xs text-muted-foreground">
                No settings match "{query.trim()}".
              </p>
            ) : (
              results.map((result) => (
                <button
                  key={`${result.categoryId}-${result.label}`}
                  type="button"
                  onClick={() => scrollToSection(result.categoryId, result.anchorId)}
                  className={cn(
                    ROW_CLASS,
                    'min-h-8 py-1.5 text-secondary-foreground hover:bg-foreground/[0.03] hover:text-foreground'
                  )}
                >
                  <span className="flex min-w-0 flex-col items-start gap-0.5">
                    <span className="max-w-full truncate">{result.label}</span>
                    <span className="max-w-full truncate text-2xs text-muted-foreground">
                      {categories.find((c) => c.id === result.categoryId)?.label}
                    </span>
                  </span>
                </button>
              ))
            )
          ) : (
            categories.map((category, index) => {
              const isActive = category.id === activeId
              const setApart = index > 0 && SET_APART_CATEGORY_IDS.has(category.id)
              return (
                <Fragment key={category.id}>
                  {setApart && (
                    <div
                      aria-hidden
                      data-testid="settings-category-divider"
                      className="hidden h-px shrink-0 bg-border md:my-1.5 md:block"
                    />
                  )}
                  <button
                    type="button"
                    data-category-button
                    aria-current={isActive ? 'true' : undefined}
                    onClick={() => scrollToSection(category.id)}
                    onKeyDown={(e) => handleCategoryKeyDown(e, index)}
                    className={cn(
                      ROW_CLASS,
                      'h-8 [&_svg]:size-3.5',
                      isActive
                        ? 'keycap text-foreground'
                        : 'text-secondary-foreground hover:bg-foreground/[0.03] hover:text-foreground'
                    )}
                  >
                    {category.icon && (
                      <span className="flex flex-shrink-0 items-center">{category.icon}</span>
                    )}
                    <span className="truncate">{category.label}</span>
                  </button>
                </Fragment>
              )
            })
          )}
        </nav>

        {sidebarFooter && <div className="border-t border-border p-2">{sidebarFooter}</div>}
      </aside>

      {/* Content */}
      <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto p-6 pb-32">
        <div className="mx-auto max-w-4xl space-y-8">{children}</div>
      </div>
    </div>
  )
}
