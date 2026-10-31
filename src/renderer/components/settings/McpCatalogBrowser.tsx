import {
  MCP_CATALOG_MAX_QUERY_CHARS,
  MCP_CATALOG_MAX_QUERY_TERMS,
  MCP_REGISTRY_URL,
  type McpCatalogRow,
  type McpCatalogState,
  type McpCatalogSync
} from '@shared/types/mcp-catalog.types'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ExternalLink, Search } from '@/components/icons'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { useSettingsSectionVisible } from '@/components/settings/SettingsLayout'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
import { SettingsSwitchRow } from '@/components/settings/SettingsSwitchRow'
import { type StatusTone, StatusWord } from '@/components/settings/StatusWord'
import { Button } from '@/components/ui/button'
import { PANEL_FIELD_CLASS, PANEL_FIELD_ICON_CLASS } from '@/components/ui/panel-styles'
import { Spinner } from '@/components/ui/spinner'
import { type McpCatalogResults, useMcpCatalogSearch } from '@/hooks/use-mcp-catalog-search'
import {
  type McpCatalogStatusHandle,
  useMcpCatalogStatus,
  useSearchFollowsCatalog
} from '@/hooks/use-mcp-catalog-status'
import { openerApi } from '@/lib/api'
import {
  MCP_CATALOG_STATE_LABEL,
  mcpCatalogReasonText,
  mcpCatalogSampleText,
  mcpCatalogSyncErrorText,
  mcpCatalogSyncText,
  mcpCatalogUpdatedText
} from '@/lib/mcp-catalog-copy'
import { cn } from '@/lib/utils'

const STATE_TONE: Record<McpCatalogState, StatusTone> = {
  installable: 'success',
  'needs-runtime': 'warning',
  unsupported: 'muted',
  'source-only': 'muted'
}

const INSTALL_SOON = 'Installing from the catalog is coming soon.'
const ESTIMATED_ROW_HEIGHT = 112
/** Fetch the next page once the last rendered row is this close to the end. */
const LOAD_AHEAD_ROWS = 8

const SYNC_TONE: Record<McpCatalogSync['state'], StatusTone> = {
  disabled: 'muted',
  idle: 'success',
  syncing: 'muted',
  failed: 'danger'
}

const count = new Intl.NumberFormat('en-US')

function summary(results: McpCatalogResults): string {
  const noun = results.query
    ? results.total === 1
      ? 'match'
      : 'matches'
    : results.total === 1
      ? 'server'
      : 'servers'
  return `${count.format(results.total)} ${noun}`
}

function openLink(url: string, failure: string): void {
  void openerApi.openUrlWithSystemBrowser(url).then((result) => {
    if (!result.success) toast.error(failure)
  })
}

function CatalogSource({ state, setSync }: McpCatalogStatusHandle): React.JSX.Element | null {
  if (state.status === 'loading') return null
  if (state.status === 'unavailable') {
    return (
      <p className="px-1 text-xs text-muted-foreground">
        Termul couldn't check where the catalog comes from.
      </p>
    )
  }
  const { catalog, requested } = state
  const sample = mcpCatalogSampleText(catalog)
  const sync = mcpCatalogSyncText(catalog)
  return (
    <SettingsCard>
      <div className="flex flex-col gap-1 px-4 py-3 text-xs text-muted-foreground">
        <p className="text-sm text-foreground">
          From the{' '}
          <Button
            type="button"
            variant="link"
            className="h-auto gap-1 p-0 text-sm"
            onClick={() => openLink(MCP_REGISTRY_URL, "Couldn't open the MCP Registry link.")}
          >
            official MCP Registry
            <ExternalLink size={12} aria-hidden />
          </Button>
        </p>
        <p>{mcpCatalogUpdatedText(catalog.updatedAt)}</p>
        {sample && <p>{sample}</p>}
        {sync && (
          <StatusWord
            tone={SYNC_TONE[catalog.sync.state]}
            pending={catalog.sync.state === 'syncing'}
          >
            {sync}
          </StatusWord>
        )}
      </div>
      <SettingsSwitchRow
        id="mcp-catalog-sync"
        label="Keep the catalog up to date"
        description="The host downloads the official MCP Registry and checks it for changes."
        checked={requested ?? catalog.sync.state !== 'disabled'}
        disabled={requested !== null}
        onToggle={(enabled) => {
          void setSync(enabled).then((result) => {
            if (!result.success) toast.error(mcpCatalogSyncErrorText(result.code))
          })
        }}
      />
    </SettingsCard>
  )
}

function CatalogRow({ row, hintId }: { row: McpCatalogRow; hintId: string }): React.JSX.Element {
  const displayName = row.title ?? row.name.slice(row.name.lastIndexOf('/') + 1)
  return (
    <div className="flex flex-col gap-2 px-4 py-3 @lg:flex-row @lg:items-start @lg:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="max-w-24 shrink-0 truncate text-3xs text-muted-foreground">
            {row.version}
          </span>
          {row.status === 'deprecated' && (
            <span className="shrink-0 rounded bg-warning/10 px-1.5 py-px text-3xs font-medium uppercase text-warning">
              Deprecated
            </span>
          )}
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground" title={row.name}>
          {row.name}
        </p>
        {row.description && (
          <p className="mt-1 line-clamp-2 break-words text-xs text-secondary-foreground">
            {row.description}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <StatusWord tone={STATE_TONE[row.state]}>{MCP_CATALOG_STATE_LABEL[row.state]}</StatusWord>
          {row.reason && (
            <span className="text-xs text-muted-foreground">
              {mcpCatalogReasonText(row.reason)}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {row.repositoryUrl && (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label={`Open the ${displayName} repository`}
            onClick={() =>
              openLink(row.repositoryUrl as string, "Couldn't open the repository link.")
            }
          >
            <ExternalLink size={13} />
            Repository
          </Button>
        )}
        <span title={INSTALL_SOON}>
          <Button type="button" size="xs" variant="outline" disabled aria-describedby={hintId}>
            Install
          </Button>
        </span>
      </div>
    </div>
  )
}

function CatalogList({
  rows,
  hintId,
  onNearEnd
}: {
  rows: McpCatalogRow[]
  hintId: string
  /** Absent while a page is loading or the last one failed. */
  onNearEnd: (() => void) | undefined
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 6,
    getItemKey: (index) => rows[index]?.name ?? index
  })
  const items = virtualizer.getVirtualItems()
  const lastRendered = items.at(-1)?.index

  useEffect(() => {
    if (lastRendered !== undefined && lastRendered >= rows.length - LOAD_AHEAD_ROWS) onNearEnd?.()
  }, [lastRendered, rows.length, onNearEnd])

  return (
    <div
      ref={scrollRef}
      data-testid="mcp-catalog-scroll"
      className="max-h-[min(36rem,65dvh)] overflow-y-auto overscroll-contain"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index]
          if (!row) return null
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className={cn(
                'absolute left-0 top-0 w-full',
                item.index < rows.length - 1 && 'border-b border-border'
              )}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <CatalogRow row={row} hintId={hintId} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Browse and search the host's MCP catalog (SPEC CAP-1, CAP-4) and say where
 * it comes from. Search and status are reads, so shared-live viewers browse
 * too; only the host can turn sync on or off. Install arrives with the
 * consent flow.
 */
export function McpCatalogBrowser(): React.JSX.Element {
  const visible = useSettingsSectionVisible()
  const [query, setQuery] = useState('')
  const search = useMcpCatalogSearch(query, visible)
  const { state, canLoadMore, loadMore, retry } = search
  const status = useMcpCatalogStatus(visible)
  useSearchFollowsCatalog(status.state.status === 'ready' ? status.state.catalog : null, search)
  const hintId = useId()

  const results =
    state.status === 'ready' ? state.results : state.status === 'loading' ? state.previous : null
  const more = state.status === 'ready' ? state.more : 'idle'

  return (
    <SettingsGroup
      title="MCP catalog"
      footnote={
        <span id={hintId}>{INSTALL_SOON} Until then, add servers by hand in the list above.</span>
      }
    >
      <CatalogSource {...status} />
      <div className="relative">
        <Search size={13} aria-hidden className={PANEL_FIELD_ICON_CLASS} />
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={MCP_CATALOG_MAX_QUERY_CHARS}
          placeholder="Search the MCP catalog"
          aria-label="Search the MCP catalog"
          className={cn(PANEL_FIELD_CLASS, 'h-8 w-full bg-background pl-7 pr-8')}
        />
        {state.status === 'loading' && results !== null && (
          <Spinner
            size={13}
            label="Searching"
            className="absolute right-2.5 top-1/2 -translate-y-1/2"
          />
        )}
      </div>

      {state.status === 'too-many-terms' ? (
        <SettingsNotice tone="warning">
          Search with {MCP_CATALOG_MAX_QUERY_TERMS} words or fewer.
        </SettingsNotice>
      ) : state.status === 'failed' ? (
        <SettingsNotice
          tone="danger"
          action={
            <Button type="button" size="xs" variant="outline" onClick={retry}>
              Try again
            </Button>
          }
        >
          Termul couldn't load the MCP catalog.
        </SettingsNotice>
      ) : results === null ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
          <Spinner size={13} decorative />
          Loading the catalog…
        </div>
      ) : (
        <>
          <p aria-live="polite" className="px-1 text-xs text-muted-foreground">
            {summary(results)}
          </p>
          {results.updatedAt === null ? (
            <SettingsNotice tone="warning">
              No catalog is loaded yet, so there is nothing to browse.
            </SettingsNotice>
          ) : results.rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-5 text-center">
              <p className="text-xs text-muted-foreground">No servers match "{results.query}".</p>
              <Button type="button" size="xs" variant="outline" onClick={() => setQuery('')}>
                Clear search
              </Button>
            </div>
          ) : (
            <SettingsCard aria-busy={state.status === 'loading'}>
              <CatalogList
                rows={results.rows}
                hintId={hintId}
                onNearEnd={canLoadMore && more === 'idle' ? loadMore : undefined}
              />
            </SettingsCard>
          )}
          {results.nextCursor !== null && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-muted-foreground">
              <span>
                Showing {count.format(results.rows.length)} of {count.format(results.total)}.
                {!canLoadMore && ' Search to narrow the list.'}
              </span>
              {canLoadMore && more === 'loading' && <Spinner size={13} label="Loading more" />}
              {canLoadMore && more !== 'loading' && (
                <Button type="button" size="xs" variant="outline" onClick={loadMore}>
                  {more === 'failed' ? 'Try again' : 'Load more'}
                </Button>
              )}
              {more === 'failed' && <span>Couldn't load more servers.</span>}
            </div>
          )}
        </>
      )}
    </SettingsGroup>
  )
}
