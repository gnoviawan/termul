import type { FileSearchResult } from '@shared/types/filesystem.types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, Search, X } from '@/components/icons'
import {
  FOCUS_RING_CLASS,
  PANEL_FIELD_CLASS,
  PANEL_FIELD_ICON_CLASS,
  QUIET_ICON_BUTTON_CLASS,
  SEGMENTED_TRACK_CLASS,
  segmentClass
} from '@/components/ui/panel-styles'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { MaterialFileIcon } from './MaterialFileIcon'

/** Content | Files segment: equal halves of the track. */
const SEGMENT_CLASS = 'h-6 flex-1 justify-center gap-1'

interface ExplorerSearchFieldProps {
  value: string
  onChange: (value: string) => void
  onClear: () => void
}

/** Shared panel field (32px) with a clear button while it holds text. */
export function ExplorerSearchField({
  value,
  onChange,
  onClear
}: ExplorerSearchFieldProps): React.JSX.Element {
  return (
    <div className="flex-shrink-0 px-2 pb-2">
      <div className="relative">
        <Search size={13} aria-hidden className={PANEL_FIELD_ICON_CLASS} />
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Search files and content"
          className={cn(PANEL_FIELD_CLASS, 'h-8 w-full pl-7 pr-7')}
          aria-label="Search files and content"
        />
        {value.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            className={cn(
              QUIET_ICON_BUTTON_CLASS,
              'absolute right-1.5 top-1/2 size-5 -translate-y-1/2'
            )}
            title="Clear search"
            aria-label="Clear search"
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  )
}

/** File name and its root-relative folder ('' at the root). */
function splitFilePath(
  filePath: string,
  rootPath: string
): { fileName: string; folderPath: string } {
  const normalizedFilePath = filePath.replace(/\\/g, '/')
  const normalizedRootPath = rootPath.replace(/\\/g, '/')
  const fileName = normalizedFilePath.split('/').pop() ?? normalizedFilePath
  const relativePath = normalizedRootPath
    ? normalizedFilePath.replace(`${normalizedRootPath}/`, '')
    : normalizedFilePath
  const folderPath = relativePath.includes('/')
    ? relativePath.slice(0, relativePath.lastIndexOf('/'))
    : ''
  return { fileName, folderPath }
}

function extensionOf(fileName: string): string | null {
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex > 0 ? fileName.slice(dotIndex + 1) : null
}

function HighlightedLine({ text, query }: { text: string; query: string }): React.JSX.Element {
  const trimmed = query.trim()
  if (!trimmed) return <>{text}</>

  const lowerLine = text.toLowerCase()
  const lowerQuery = trimmed.toLowerCase()
  const parts: React.ReactNode[] = []
  let startIndex = 0
  let matchIndex = lowerLine.indexOf(lowerQuery, startIndex)

  while (matchIndex !== -1) {
    if (matchIndex > startIndex) {
      parts.push(text.slice(startIndex, matchIndex))
    }
    parts.push(
      <span
        key={`${matchIndex}-${matchIndex + trimmed.length}`}
        className="rounded-sm bg-primary/20 text-foreground"
      >
        {text.slice(matchIndex, matchIndex + trimmed.length)}
      </span>
    )
    startIndex = matchIndex + trimmed.length
    matchIndex = lowerLine.indexOf(lowerQuery, startIndex)
  }

  if (startIndex < text.length) {
    parts.push(text.slice(startIndex))
  }

  return <>{parts.length > 0 ? parts : text}</>
}

/** h-7 file row: chevron (content results only), icon, name, folder, count. */
function SearchFileRow({
  filePath,
  rootPath,
  showChevron,
  count,
  onClick
}: {
  filePath: string
  rootPath: string
  showChevron: boolean
  count?: number
  onClick: () => void
}): React.JSX.Element {
  const { fileName, folderPath } = splitFilePath(filePath, rootPath)
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-7 w-full min-w-0 items-center gap-1 rounded-md pl-1 pr-1.5 text-left text-xs transition-colors duration-150 ease-out hover:bg-foreground/[0.03]',
        FOCUS_RING_CLASS
      )}
      title={filePath}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground/70">
        {showChevron && <ChevronDown size={11} />}
      </span>
      <MaterialFileIcon
        name={fileName}
        extension={extensionOf(fileName)}
        isDirectory={false}
        isExpanded={false}
        depth={0}
        size={14}
      />
      <span className="ml-0.5 shrink-0 truncate font-medium text-foreground">{fileName}</span>
      <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">{folderPath}</span>
      {count !== undefined && (
        <span
          className="flex h-4 shrink-0 items-center rounded-full bg-foreground/[0.06] px-1.5 text-3xs tabular-nums text-muted-foreground"
          title={`${count} hit${count === 1 ? '' : 's'}`}
        >
          {count}
        </span>
      )}
    </button>
  )
}

type SearchResultTab = 'content' | 'files'

export interface ExplorerSearchResultsProps {
  rootPath: string
  /** Raw query (highlight uses the live query, as before). */
  query: string
  trimmedQuery: string
  results: FileSearchResult[]
  fileNameMatches: string[]
  fileNameMatchesPending: boolean
  loading: boolean
  error: string | null
  isTooShort: boolean
  showEmptyState: boolean
  resultsAreCurrent: boolean
  truncated: boolean
  scannedFiles: number
  failedFiles: number
  onOpenMatch: (filePath: string, lineNumber: number) => void
}

/**
 * Search results: Content | Files segmented track, the result rows, and one
 * quiet status line at the end of the list.
 */
export function ExplorerSearchResults({
  rootPath,
  query,
  trimmedQuery,
  results,
  fileNameMatches,
  fileNameMatchesPending,
  loading,
  error,
  isTooShort,
  showEmptyState,
  resultsAreCurrent,
  truncated,
  scannedFiles,
  failedFiles,
  onOpenMatch
}: ExplorerSearchResultsProps): React.JSX.Element {
  const [tab, setTab] = useState<SearchResultTab>('content')
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [activeMatchKey, setActiveMatchKey] = useState<string | null>(null)
  const userSelectedTabRef = useRef(false)

  const hasContentResults = results.length > 0
  const hasFileResults = fileNameMatches.length > 0
  const hasAnyResults = hasContentResults || hasFileResults
  const hasPartialError = Boolean(error) && hasAnyResults

  // Follow the side that has results until the user picks a tab.
  useEffect(() => {
    if (userSelectedTabRef.current) return
    if (tab === 'content' && results.length === 0 && fileNameMatches.length > 0 && !loading) {
      setTab('files')
      return
    }
    if (tab === 'files' && fileNameMatches.length === 0 && results.length > 0 && !loading) {
      setTab('content')
    }
  }, [fileNameMatches.length, tab, results.length, loading])

  const selectTab = (next: SearchResultTab): void => {
    userSelectedTabRef.current = true
    setTab(next)
  }

  const toggleExpanded = useCallback((filePath: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(filePath)) {
        next.delete(filePath)
      } else {
        next.add(filePath)
      }
      return next
    })
  }, [])

  const openMatch = (filePath: string, lineNumber: number, key: string): void => {
    setActiveMatchKey(key)
    onOpenMatch(filePath, lineNumber)
  }

  const showStatus = loading || Boolean(error) || isTooShort || showEmptyState || !resultsAreCurrent

  const statusTitle = loading
    ? `Searching for “${trimmedQuery}”…`
    : hasPartialError
      ? `Partial results for “${trimmedQuery}”`
      : error
        ? 'Search unavailable'
        : isTooShort
          ? 'Keep typing to start searching'
          : showEmptyState
            ? `No matches for “${trimmedQuery}”`
            : `Updating results for “${trimmedQuery}”…`

  const statusHint = hasPartialError
    ? `${error} Showing the matches that were found before the search stopped.`
    : error
      ? error
      : isTooShort
        ? 'Type at least 2 characters to search file names and content.'
        : showEmptyState
          ? 'Try a different term or a shorter phrase to broaden the search.'
          : 'Finishing the latest search before showing refreshed matches.'

  return (
    <div className="px-2 pb-2">
      {hasAnyResults && (
        <div
          className={cn(SEGMENTED_TRACK_CLASS, 'mb-1 h-7')}
          role="tablist"
          aria-label="Search result types"
        >
          {(
            [
              ['content', 'Content', results.length],
              ['files', 'Files', fileNameMatchesPending ? '…' : fileNameMatches.length]
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => selectTab(value)}
              className={cn(segmentClass(tab === value), SEGMENT_CLASS)}
            >
              {label} <span className="text-2xs tabular-nums text-muted-foreground">{count}</span>
            </button>
          ))}
        </div>
      )}

      {tab === 'files' && hasFileResults && (
        <div>
          {fileNameMatches.map((filePath) => (
            <SearchFileRow
              key={`fname:${filePath}`}
              filePath={filePath}
              rootPath={rootPath}
              showChevron={false}
              onClick={() => onOpenMatch(filePath, 1)}
            />
          ))}
        </div>
      )}

      {tab === 'content' && hasContentResults && (
        <div>
          {results.map((fileResult) => {
            const isExpanded = expandedPaths.has(fileResult.filePath)
            const visibleMatches = isExpanded ? fileResult.matches : fileResult.matches.slice(0, 3)
            const hiddenCount = Math.max(fileResult.matches.length - visibleMatches.length, 0)
            return (
              <div key={fileResult.filePath} className="pb-1">
                <SearchFileRow
                  filePath={fileResult.filePath}
                  rootPath={rootPath}
                  showChevron
                  count={fileResult.matches.length}
                  onClick={() =>
                    onOpenMatch(fileResult.filePath, fileResult.matches[0]?.lineNumber ?? 1)
                  }
                />
                {visibleMatches.map((match, idx) => {
                  const key = `${fileResult.filePath}:${match.lineNumber}:${idx}`
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => openMatch(fileResult.filePath, match.lineNumber, key)}
                      className={cn(
                        'flex h-6 w-full min-w-0 items-center gap-2 rounded-md pl-1 pr-1.5 text-left transition-colors duration-150 ease-out',
                        FOCUS_RING_CLASS,
                        activeMatchKey === key
                          ? 'keycap text-foreground'
                          : 'hover:bg-foreground/[0.03]'
                      )}
                    >
                      <span className="w-5 shrink-0 text-right font-mono text-3xs tabular-nums text-muted-foreground">
                        {match.lineNumber}
                      </span>
                      <span className="block min-w-0 flex-1 truncate font-mono text-2xs text-foreground/90">
                        <HighlightedLine text={match.lineText} query={query} />
                      </span>
                    </button>
                  )
                })}
                {fileResult.matches.length > 3 && (
                  <button
                    type="button"
                    onClick={() => toggleExpanded(fileResult.filePath)}
                    className={cn(
                      'h-6 rounded-md pl-8 pr-1.5 text-2xs text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground',
                      FOCUS_RING_CLASS
                    )}
                  >
                    {isExpanded ? 'Show less' : `Show ${hiddenCount} more`}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {showStatus && (
        <div
          role="status"
          className="flex items-start gap-1.5 px-1 pt-1.5 text-2xs text-muted-foreground"
        >
          {loading && <Spinner size={11} decorative className="mt-px shrink-0" />}
          <div className="min-w-0">
            <p className="font-medium">{statusTitle}</p>
            <p className="mt-0.5 text-muted-foreground/80">{statusHint}</p>
          </div>
        </div>
      )}

      {(truncated || failedFiles > 0) && (
        <p className="px-1 pt-1.5 text-2xs text-muted-foreground">
          {truncated
            ? 'Results were truncated for performance.'
            : 'Some files could not be fully searched.'}
          {failedFiles > 0
            ? ` ${failedFiles} file${failedFiles === 1 ? ' was' : 's were'} skipped.`
            : ''}
          {scannedFiles > 0 ? ` Scanned ${scannedFiles} file${scannedFiles === 1 ? '' : 's'}.` : ''}
        </p>
      )}
    </div>
  )
}
