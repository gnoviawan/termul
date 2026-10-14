import type { SSHProfile } from '@shared/types/ssh.types'
import { useEffect, useRef } from 'react'
import { Server, X } from '@/components/icons'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'
import { SSH_HOSTS_TAB, type SSHSession } from '@/stores/ssh-store'
import { hostStateWord, SSHHostLamp, sessionHostState } from './ssh-host-status'

interface SSHSessionTabsProps {
  sessions: SSHSession[]
  profiles: SSHProfile[]
  activeTab: string
  onSelect: (tab: string) => void
  /** Close a session tab (the caller confirms when it is live). */
  onClose: (sessionId: string) => void
}

export function sshTabId(tab: string): string {
  return `ssh-tab-${tab}`
}

export function sshPanelId(tab: string): string {
  return `ssh-panel-${tab}`
}

/** Label per tab; a host open in several tabs gets a running number. */
export function sessionLabels(sessions: SSHSession[], profiles: SSHProfile[]): Map<string, string> {
  const names = new Map(profiles.map((p) => [p.id, p.name]))
  const totals = new Map<string, number>()
  for (const s of sessions) totals.set(s.profileId, (totals.get(s.profileId) ?? 0) + 1)
  const seen = new Map<string, number>()
  const labels = new Map<string, string>()
  for (const s of sessions) {
    const index = (seen.get(s.profileId) ?? 0) + 1
    seen.set(s.profileId, index)
    const name = names.get(s.profileId) ?? 'Removed host'
    labels.set(s.id, (totals.get(s.profileId) ?? 0) > 1 ? `${name} (${index})` : name)
  }
  return labels
}

const TAB_CLASS =
  'group relative flex h-8 min-w-0 shrink-0 items-center gap-2 rounded-md px-2.5 text-xs transition-colors duration-150 ease-out'

/**
 * Hosts tab plus one tab per session (WAI-ARIA tabs: arrows move, Home/End
 * jump, Enter/Space or focus selects; middle-click or the × closes).
 */
export function SSHSessionTabs({
  sessions,
  profiles,
  activeTab,
  onSelect,
  onClose
}: SSHSessionTabsProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const tabs = [SSH_HOSTS_TAB, ...sessions.map((s) => s.id)]
  const labels = sessionLabels(sessions, profiles)

  // The strip scrolls without a visible bar: keep the active tab in view.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`#${CSS.escape(sshTabId(activeTab))}`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeTab])

  const focusTab = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length]
    onSelect(tab)
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(sshTabId(tab))}`)?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent, index: number, sessionId?: string) => {
    if (e.key === 'ArrowRight') focusTab(index + 1)
    else if (e.key === 'ArrowLeft') focusTab(index - 1)
    else if (e.key === 'Home') focusTab(0)
    else if (e.key === 'End') focusTab(tabs.length - 1)
    else if (e.key === 'Delete' && sessionId) onClose(sessionId)
    else return
    e.preventDefault()
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="SSH sessions"
      className="scrollbar-hide flex min-w-0 items-center gap-0.5 overflow-x-auto"
    >
      <button
        type="button"
        role="tab"
        id={sshTabId(SSH_HOSTS_TAB)}
        aria-selected={activeTab === SSH_HOSTS_TAB}
        aria-controls={sshPanelId(SSH_HOSTS_TAB)}
        tabIndex={activeTab === SSH_HOSTS_TAB ? 0 : -1}
        onClick={() => onSelect(SSH_HOSTS_TAB)}
        onKeyDown={(e) => handleKeyDown(e, 0)}
        className={cn(
          TAB_CLASS,
          FOCUS_RING_CLASS,
          activeTab === SSH_HOSTS_TAB
            ? 'keycap text-foreground'
            : 'text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground'
        )}
      >
        <Server size={13} aria-hidden="true" />
        <span className="font-medium">Hosts</span>
      </button>

      {sessions.map((session, i) => {
        const selected = activeTab === session.id
        const state = sessionHostState(session)
        const label = labels.get(session.id) ?? ''
        return (
          <div
            key={session.id}
            className={cn(
              TAB_CLASS,
              'max-w-56 pr-1',
              selected
                ? 'keycap text-foreground'
                : 'text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground'
            )}
          >
            <button
              type="button"
              role="tab"
              id={sshTabId(session.id)}
              aria-selected={selected}
              aria-controls={sshPanelId(session.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(session.id)}
              onMouseDown={(e) => {
                // Middle-click closes, like browser tabs.
                if (e.button === 1) {
                  e.preventDefault()
                  onClose(session.id)
                }
              }}
              onKeyDown={(e) => handleKeyDown(e, i + 1, session.id)}
              className={cn('flex min-w-0 items-center gap-2 rounded-sm', FOCUS_RING_CLASS)}
              data-testid="ssh-session-tab"
              data-state={state}
            >
              <SSHHostLamp state={state} />
              <span className="truncate">{label}</span>
              <span className="sr-only">, {hostStateWord(state)}</span>
            </button>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => onClose(session.id)}
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-foreground/[0.06] hover:text-foreground',
                selected
                  ? 'opacity-100'
                  : 'pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100'
              )}
              aria-label={`Close ${label}`}
              title="Close session (Delete)"
            >
              <X size={11} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
