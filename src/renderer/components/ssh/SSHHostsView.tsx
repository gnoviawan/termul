import type { SSHProfile } from '@shared/types/ssh.types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Download, Eye, EyeOff, Plus, Search, Server, X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import {
  BAND_FOCUS_CLASS,
  INNER_FIELD_FOCUS_CLASS,
  QUIET_ICON_BUTTON_CLASS
} from '@/components/ui/panel-styles'
import { isTauriContext } from '@/lib/tauri-runtime'
import { cn } from '@/lib/utils'
import { type SSHSession, useSSHActions, useSSHShowAddresses } from '@/stores/ssh-store'
import { type SSHHostActions, SSHHostRow } from './SSHHostRow'
import { resolveSSHHostState } from './ssh-host-status'

interface SSHHostsViewProps {
  profiles: SSHProfile[]
  sessions: SSHSession[]
  selectedProfileId: string | null
  actions: SSHHostActions
  onNewHost: () => void
  onImport: () => void
}

interface HostSection {
  key: string
  title: string
  hosts: SSHProfile[]
}

export function matchesHostQuery(profile: SSHProfile, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [
    profile.name,
    profile.host,
    profile.username,
    `${profile.username}@${profile.host}`,
    profile.group ?? '',
    ...(profile.tags ?? [])
  ]
  return haystack.some((value) => value.toLowerCase().includes(q))
}

/** Favorites first, then one section per group, then ungrouped hosts. */
export function groupHosts(profiles: SSHProfile[]): HostSection[] {
  const byName = (a: SSHProfile, b: SSHProfile) => a.name.localeCompare(b.name)
  const sections: HostSection[] = []
  const favorites = profiles.filter((p) => p.favorite).sort(byName)
  if (favorites.length > 0)
    sections.push({ key: 'favorites', title: 'Favorites', hosts: favorites })
  const rest = profiles.filter((p) => !p.favorite)
  const groups = new Map<string, SSHProfile[]>()
  for (const profile of rest) {
    const group = profile.group?.trim() ?? ''
    groups.set(group, [...(groups.get(group) ?? []), profile])
  }
  const named = [...groups.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b))
  for (const group of named) {
    sections.push({ key: `group:${group}`, title: group, hosts: groups.get(group)!.sort(byName) })
  }
  const ungrouped = groups.get('') ?? []
  if (ungrouped.length > 0) {
    sections.push({
      key: 'ungrouped',
      title: sections.length > 0 ? 'Other hosts' : 'All hosts',
      hosts: ungrouped.sort(byName)
    })
  }
  return sections
}

/** The SSH library: search, group and act on saved hosts. */
export function SSHHostsView({
  profiles,
  sessions,
  selectedProfileId,
  actions,
  onNewHost,
  onImport
}: SSHHostsViewProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const desktop = isTauriContext()
  const showAddresses = useSSHShowAddresses()
  const { toggleShowAddresses } = useSSHActions()

  const sections = useMemo(
    () => groupHosts(profiles.filter((p) => matchesHostQuery(p, query))),
    [profiles, query]
  )

  // "/" jumps to search, as in most host lists.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"], .xterm')) return
      // The view stays mounted under a hidden tab panel; leave "/" alone then.
      const search = searchRef.current
      if (!search || search.closest('[hidden]')) return
      e.preventDefault()
      search.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const moveFocus = (direction: 1 | -1, from: HTMLElement) => {
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-ssh-host-button]') ?? []
    )
    const next = buttons[buttons.indexOf(from) + direction]
    if (next) next.focus()
    else if (direction === -1) searchRef.current?.focus()
  }

  const sessionsFor = (profileId: string) => sessions.filter((s) => s.profileId === profileId)

  if (profiles.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="ssh-hosts-empty">
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-foreground/[0.06] text-muted-foreground">
            <Server size={22} aria-hidden="true" />
          </span>
          <div className="space-y-1.5">
            <h2 className="text-base font-semibold text-foreground">No hosts yet</h2>
            <p className="text-sm text-muted-foreground">
              Add a server to open a terminal on it from Termul, or import the hosts in your
              ~/.ssh/config.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" size="sm" onClick={onNewHost}>
              <Plus />
              New host
            </Button>
            {desktop && (
              <Button type="button" size="sm" variant="outline" onClick={onImport}>
                <Download />
                Import ~/.ssh/config
              </Button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-6 py-3">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-2">
          <div
            className={cn(
              'flex h-9 min-w-48 flex-1 items-center gap-2 rounded-lg border border-border bg-background px-3',
              BAND_FOCUS_CLASS
            )}
          >
            <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault()
                  setQuery('')
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  listRef.current?.querySelector<HTMLElement>('[data-ssh-host-button]')?.focus()
                }
              }}
              placeholder="Search by name, address, group or tag"
              aria-label="Search hosts"
              className={cn(
                'h-full min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground pointer-coarse:text-base',
                INNER_FIELD_FOCUS_CLASS
              )}
            />
            {query ? (
              <button
                type="button"
                className={cn(QUIET_ICON_BUTTON_CLASS, 'size-6')}
                onClick={() => {
                  setQuery('')
                  searchRef.current?.focus()
                }}
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            ) : (
              <span aria-hidden="true" title="Press / to search">
                <Kbd className="px-1.5 py-px font-mono">/</Kbd>
              </span>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-9 px-0"
            onClick={toggleShowAddresses}
            aria-label="Show addresses"
            aria-pressed={showAddresses}
            title={showAddresses ? 'Hide usernames and addresses' : 'Show usernames and addresses'}
          >
            {showAddresses ? <Eye /> : <EyeOff />}
          </Button>
          {desktop && (
            <Button type="button" size="sm" variant="outline" onClick={onImport}>
              <Download />
              Import
            </Button>
          )}
          <Button type="button" size="sm" onClick={onNewHost}>
            <Plus />
            New host
          </Button>
        </div>
      </div>

      {!desktop && (
        <p className="border-b border-border bg-card px-6 py-2 text-center text-xs text-muted-foreground">
          You can manage hosts here. Connecting to them works in the Termul desktop app.
        </p>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-4">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
          {sections.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center" role="status">
              <p className="text-sm text-foreground">No hosts match “{query.trim()}”.</p>
              <Button type="button" size="xs" variant="ghost" onClick={() => setQuery('')}>
                Show all hosts
              </Button>
            </div>
          ) : (
            sections.map((section) => (
              <section
                key={section.key}
                aria-labelledby={`ssh-section-${section.key}`}
                className="flex flex-col gap-2"
              >
                <h3 id={`ssh-section-${section.key}`} className="label-panel px-2.5">
                  {section.title}{' '}
                  <span className="ml-1 font-normal tabular-nums">{section.hosts.length}</span>
                </h3>
                <ul className="flex flex-col gap-0.5">
                  {section.hosts.map((profile) => {
                    const hostSessions = sessionsFor(profile.id)
                    return (
                      <SSHHostRow
                        key={profile.id}
                        profile={profile}
                        state={resolveSSHHostState(hostSessions)}
                        sessionCount={hostSessions.length}
                        selected={selectedProfileId === profile.id}
                        canConnect={desktop}
                        showAddress={showAddresses}
                        actions={actions}
                        onArrow={moveFocus}
                      />
                    )
                  })}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/** Toast for an import result. */
export function reportImport(imported: SSHProfile[]): void {
  if (imported.length > 0) {
    toast.success(
      `Imported ${imported.length} ${imported.length === 1 ? 'host' : 'hosts'} from ~/.ssh/config`
    )
  } else {
    toast.info('No new hosts found in ~/.ssh/config')
  }
}
