import {
  MCP_CATALOG_MAX_QUERY_CHARS,
  MCP_CATALOG_MAX_QUERY_TERMS,
  MCP_REGISTRY_URL,
  type McpCatalogRow,
  type McpCatalogState,
  type McpCatalogSync
} from '@shared/types/mcp-catalog.types'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ExternalLink, Search } from '@/components/icons'
import { McpCatalogIcon } from '@/components/settings/McpCatalogIcon'
import { McpCatalogInstallDialog } from '@/components/settings/McpCatalogInstallDialog'
import { SettingsCard, SettingsGroup } from '@/components/settings/SettingsGroup'
import { useSettingsSectionVisible } from '@/components/settings/SettingsLayout'
import { SettingsNotice } from '@/components/settings/SettingsNotice'
import { SettingsSwitchRow } from '@/components/settings/SettingsSwitchRow'
import { type StatusTone, StatusWord } from '@/components/settings/StatusWord'
import { Button } from '@/components/ui/button'
import { PANEL_FIELD_CLASS, PANEL_FIELD_ICON_CLASS } from '@/components/ui/panel-styles'
import { Spinner } from '@/components/ui/spinner'
import { useMcpCatalogInstall } from '@/hooks/use-mcp-catalog-install'
import { type McpCatalogResults, useMcpCatalogSearch } from '@/hooks/use-mcp-catalog-search'
import {
  type McpCatalogStatusHandle,
  useMcpCatalogStatus,
  useSearchFollowsCatalog
} from '@/hooks/use-mcp-catalog-status'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { openerApi } from '@/lib/api'
import {
  MCP_CATALOG_STATE_LABEL,
  MCP_INSTALL_BLOCK_TEXT,
  type McpInstallBlock,
  mcpCatalogReasonText,
  mcpCatalogSampleText,
  mcpCatalogSyncErrorText,
  mcpCatalogSyncText,
  mcpCatalogUpdatedText
} from '@/lib/mcp-catalog-copy'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { useAcpStore } from '@/stores/acp-store'
import { useProjectStore } from '@/stores/project-store'

const STATE_TONE: Record<McpCatalogState, StatusTone> = {
  installable: 'success',
  'needs-runtime': 'warning',
  unsupported: 'muted',
  'source-only': 'muted'
}

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

interface RowInstall {
  installed: ReadonlySet<string>
  block: { reason: McpInstallBlock; hintId: string } | null
  onInstall: (row: McpCatalogRow) => void
}

function CatalogRow({
  row,
  install
}: {
  row: McpCatalogRow
  install: RowInstall
}): React.JSX.Element {
  const reasonId = useId()
  const displayName = row.title ?? row.name.slice(row.name.lastIndexOf('/') + 1)
  const reason = row.reason && mcpCatalogReasonText(row.reason)
  return (
    <div className="flex flex-col gap-2 px-4 py-3 @lg:flex-row @lg:items-start @lg:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <McpCatalogIcon name={row.name} displayName={displayName} hasIcon={row.hasIcon} />
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
            <StatusWord tone={STATE_TONE[row.state]}>
              {MCP_CATALOG_STATE_LABEL[row.state]}
            </StatusWord>
            {reason && (
              <span id={reasonId} className="text-xs text-muted-foreground">
                {reason}
              </span>
            )}
          </div>
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
        {install.installed.has(row.name) ? (
          <StatusWord tone="success">Installed</StatusWord>
        ) : (
          <span
            title={
              install.block ? MCP_INSTALL_BLOCK_TEXT[install.block.reason] : (reason ?? undefined)
            }
          >
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={install.block !== null || row.state !== 'installable'}
              aria-describedby={
                install.block ? install.block.hintId : reason ? reasonId : undefined
              }
              onClick={() => install.onInstall(row)}
            >
              Install
            </Button>
          </span>
        )}
      </div>
    </div>
  )
}

function CatalogList({
  rows,
  install,
  onNearEnd
}: {
  rows: McpCatalogRow[]
  install: RowInstall
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
              <CatalogRow row={row} install={install} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function McpCatalogBrowser(): React.JSX.Element {
  const visible = useSettingsSectionVisible()
  const [query, setQuery] = useState('')
  const search = useMcpCatalogSearch(query, visible)
  const { state, canLoadMore, loadMore, retry } = search
  const status = useMcpCatalogStatus(visible)
  useSearchFollowsCatalog(status.state.status === 'ready' ? status.state.catalog : null, search)
  const hintId = useId()
  const install = useMcpCatalogInstall()
  const admitsWrites = useServerAdmitsRemoteWrites()
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const mcpServers = useAcpStore((state) => state.mcpServers)
  const installed = useMemo(
    () => new Set(mcpServers.flatMap((server) => (server.catalog ? [server.catalog.name] : []))),
    [mcpServers]
  )
  const block: McpInstallBlock | null = !admitsWrites
    ? 'view-only'
    : !isTauriContext() && !activeProjectId
      ? 'no-project'
      : null
  const rowInstall: RowInstall = {
    installed,
    block: block && { reason: block, hintId },
    onInstall: install.start
  }
  const syncOff = status.state.status === 'ready' && status.state.catalog.sync.state === 'disabled'

  const results =
    state.status === 'ready' ? state.results : state.status === 'loading' ? state.previous : null
  const more = state.status === 'ready' ? state.more : 'idle'

  return (
    <SettingsGroup
      title="MCP catalog"
      footnote={block && <span id={hintId}>{MCP_INSTALL_BLOCK_TEXT[block]}</span>}
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
                install={rowInstall}
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
      <McpCatalogInstallDialog
        install={install}
        onEnableSync={
          syncOff
            ? () => {
                void status.setSync(true).then((result) => {
                  if (!result.success) toast.error(mcpCatalogSyncErrorText(result.code))
                })
              }
            : null
        }
      />
    </SettingsGroup>
  )
}
