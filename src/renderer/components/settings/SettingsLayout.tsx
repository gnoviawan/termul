import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { Search, X } from '@/components/icons'
import {
  FOCUS_RING_CLASS,
  PANEL_FIELD_CLASS,
  PANEL_FIELD_ICON_CLASS,
  QUIET_ICON_BUTTON_CLASS
} from '@/components/ui/panel-styles'
import { type SettingsSearchEntry, searchSettings } from '@/lib/settings-search'
import { cn } from '@/lib/utils'

/** A settings page, shown in the sidebar. */
export interface SettingsCategory {
  /** Stable id; also the page id (`data-settings-section`). */
  id: string
  /** Sidebar label and page title. */
  label: string
  /** One line of help under the page title. */
  description?: string
  /** Sidebar group heading. Consecutive pages with the same group share it. */
  group?: string
  /** Optional icon rendered before the label. */
  icon?: React.ReactNode
}

interface SettingsLayoutProps {
  /** Pages in display order. */
  categories: SettingsCategory[]
  /** Flat search index across every page. */
  searchIndex: readonly SettingsSearchEntry[]
  /** Pages, each wrapped in {@link SettingsSection}. Every page stays mounted. */
  children: React.ReactNode
  /** Sidebar title, e.g. "Preferences". */
  title: string
  /** Optional line under the sidebar title, e.g. the project name. */
  subtitle?: React.ReactNode
  /** Close the modal. Renders the page header's Close button. */
  onClose?: () => void
  /** Controlled active page id. */
  page?: string
  /** Initial page when uncontrolled. Defaults to the first category. */
  defaultPage?: string
  /** Called when the active page changes. */
  onPageChange?: (page: string) => void
  /** Optional extra content at the bottom of the sidebar. */
  sidebarFooter?: React.ReactNode
}

/** How long a search jump marks its target row. */
export const SETTINGS_TARGET_MS = 2000

const ActivePageContext = createContext<string | undefined>(undefined)
const SectionVisibleContext = createContext(true)

/** False while this settings page is mounted but hidden behind another page. */
export function useSettingsSectionVisible(): boolean {
  return useContext(SectionVisibleContext)
}

const ROW_CLASS = `flex flex-shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left text-xs transition-colors duration-150 ease-out md:w-full ${FOCUS_RING_CLASS}`

/**
 * One settings page. It stays mounted (form state and search anchors keep
 * working) and is hidden unless it is the active page.
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
  const activeId = useContext(ActivePageContext)
  const hidden = activeId !== undefined && activeId !== id
  return (
    <section
      id={`settings-section-${id}`}
      data-settings-section={id}
      hidden={hidden}
      className={cn('flex flex-col gap-6', className)}
    >
      <SectionVisibleContext.Provider value={!hidden}>{children}</SectionVisibleContext.Provider>
    </section>
  )
}

/**
 * Shared settings shell: a sidebar of grouped pages with search, and one page
 * at a time with a pinned header (title, help, Close). Search results open the
 * page, scroll to the setting and mark it for {@link SETTINGS_TARGET_MS}. Under
 * the `md` breakpoint the sidebar becomes a top bar with a scrolling strip.
 */
export function SettingsLayout({
  categories,
  searchIndex,
  children,
  title,
  subtitle,
  onClose,
  page,
  defaultPage,
  onPageChange,
  sidebarFooter
}: SettingsLayoutProps): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [uncontrolledPage, setUncontrolledPage] = useState(defaultPage ?? categories[0]?.id)
  const activeId = page ?? uncontrolledPage
  const [query, setQuery] = useState('')
  const targetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const markedRef = useRef<HTMLElement | null>(null)
  const rafRef = useRef<number | null>(null)

  const results = useMemo(() => searchSettings(query, searchIndex), [query, searchIndex])
  const isSearching = query.trim().length > 0
  const active = categories.find((category) => category.id === activeId) ?? categories[0]

  const selectPage = useCallback(
    (id: string) => {
      if (page === undefined) setUncontrolledPage(id)
      onPageChange?.(id)
    },
    [page, onPageChange]
  )

  const clearMark = useCallback(() => {
    if (targetTimerRef.current) clearTimeout(targetTimerRef.current)
    targetTimerRef.current = null
    markedRef.current?.removeAttribute('data-settings-target')
    markedRef.current = null
  }, [])

  const cancelJump = useCallback(() => {
    if (rafRef.current === null) return
    cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }, [])

  useEffect(() => {
    return () => {
      cancelJump()
      clearMark()
    }
  }, [cancelJump, clearMark])

  // A new page starts at the top.
  useEffect(() => {
    if (activeId === undefined) return
    bodyRef.current?.scrollTo({ top: 0 })
  }, [activeId])

  const openResult = useCallback(
    (categoryId: string, anchorId?: string) => {
      selectPage(categoryId)
      clearMark()
      cancelJump()
      if (!anchorId) return
      // Wait one frame so the page is visible before measuring it.
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        clearMark()
        const target = bodyRef.current?.querySelector<HTMLElement>(`#${CSS.escape(anchorId)}`)
        if (!target) return
        target.scrollIntoView({ behavior: 'smooth', block: 'start' })
        target.setAttribute('data-settings-target', '')
        markedRef.current = target
        targetTimerRef.current = setTimeout(clearMark, SETTINGS_TARGET_MS)
      })
    },
    [selectPage, clearMark, cancelJump]
  )

  const handleCategoryKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ): void => {
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight'
    const back = event.key === 'ArrowUp' || event.key === 'ArrowLeft'
    if (!forward && !back) return
    event.preventDefault()
    const next = (index + (forward ? 1 : -1) + categories.length) % categories.length
    const nav = event.currentTarget.closest('nav')
    nav?.querySelectorAll<HTMLButtonElement>('[data-category-button]')[next]?.focus()
  }

  const closeButton = (className?: string) =>
    onClose ? (
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${title}`}
        title="Close"
        className={cn(QUIET_ICON_BUTTON_CLASS, 'size-7 shrink-0', className)}
      >
        <X size={16} />
      </button>
    ) : null

  return (
    <ActivePageContext.Provider value={active?.id}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        <aside className="flex flex-shrink-0 flex-col border-b border-border bg-card md:w-60 md:border-b-0 md:border-r">
          <div className="flex min-h-12 items-center gap-2 pl-4 pr-2.5 md:pr-4">
            <div className="min-w-0 flex-1 py-2">
              <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
              {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
            </div>
            {closeButton('md:hidden')}
          </div>
          <div className="px-3 pb-2">
            <div className="relative">
              <Search size={13} aria-hidden className={PANEL_FIELD_ICON_CLASS} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings"
                aria-label="Search settings"
                className={cn(PANEL_FIELD_CLASS, 'h-8 w-full bg-background pl-7 pr-7')}
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
            aria-label="Settings pages"
            className="flex flex-1 gap-0.5 overflow-x-auto px-3 pb-2 md:flex-col md:overflow-y-auto md:pb-3"
          >
            {isSearching ? (
              results.length === 0 ? (
                <div className="flex flex-col items-start gap-2 px-2.5 py-3">
                  <p className="text-xs text-muted-foreground">
                    No settings match "{query.trim()}".
                  </p>
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className={cn(
                      'h-7 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground hover:bg-secondary',
                      FOCUS_RING_CLASS
                    )}
                  >
                    Clear search
                  </button>
                </div>
              ) : (
                <>
                  <p className="hidden px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground md:block">
                    {results.length === 1 ? '1 result' : `${results.length} results`}
                  </p>
                  {results.map((result) => {
                    const category = categories.find((c) => c.id === result.categoryId)
                    return (
                      <button
                        key={`${result.categoryId}-${result.label}`}
                        type="button"
                        onClick={() => openResult(result.categoryId, result.anchorId)}
                        className={cn(
                          ROW_CLASS,
                          'min-h-8 py-1.5 text-secondary-foreground hover:bg-foreground/[0.03] hover:text-foreground'
                        )}
                      >
                        <span className="flex min-w-0 flex-col items-start gap-0.5">
                          <span className="max-w-full truncate">{result.label}</span>
                          <span className="max-w-full truncate text-2xs text-muted-foreground">
                            {category?.group ? `${category.group} · ` : ''}
                            {category?.label}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </>
              )
            ) : (
              categories.map((category, index) => {
                const isActive = category.id === active?.id
                const startsGroup =
                  category.group !== undefined && category.group !== categories[index - 1]?.group
                return (
                  <Fragment key={category.id}>
                    {startsGroup && (
                      <p
                        data-testid="settings-group-label"
                        className={cn(
                          'hidden px-2.5 pb-1 text-xs font-medium text-muted-foreground md:block',
                          index === 0 ? 'pt-1' : 'pt-3'
                        )}
                      >
                        {category.group}
                      </p>
                    )}
                    <button
                      type="button"
                      data-category-button
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => selectPage(category.id)}
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

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {active && (
            <header className="flex shrink-0 items-start gap-4 border-b border-border px-4 pb-4 pt-4 md:px-8 md:pt-6">
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold text-foreground">{active.label}</h2>
                {active.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{active.description}</p>
                )}
              </div>
              {closeButton('-mr-2 -mt-1 hidden md:flex')}
            </header>
          )}
          <div
            ref={bodyRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 md:px-8"
          >
            <div className="mx-auto max-w-3xl">{children}</div>
          </div>
        </div>
      </div>
    </ActivePageContext.Provider>
  )
}
