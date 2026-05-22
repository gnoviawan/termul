import { useEffect, useState } from 'react'
import type { WsAdapter } from '@shared/types/ws.types'

export function BrowserPanel(props: {
  browserUrl: string
  setBrowserUrl: (value: string) => void
  browserOpenError: string | null
  setBrowserOpenError: (value: string | null) => void
  browserTabs: Array<{ id: string; url: string; title: string }>
  setBrowserTabs: React.Dispatch<React.SetStateAction<Array<{ id: string; url: string; title: string }>>>
  activeBrowserTabId: string | null
  setActiveBrowserTabId: (value: string | null) => void
}): React.JSX.Element {
  const {
    browserUrl,
    setBrowserUrl,
    browserOpenError,
    setBrowserOpenError,
    browserTabs,
    setBrowserTabs,
    activeBrowserTabId,
    setActiveBrowserTabId,
  } = props

  return (
    <div className="flex h-full items-start justify-center p-6 text-foreground">
      <div className="w-full max-w-6xl space-y-4 rounded-lg border border-border bg-card p-6">
        <div className="text-base font-semibold">Browser</div>
        <div className="flex gap-2">
          <input value={browserUrl} onChange={(e) => {
            const nextUrl = e.target.value
            setBrowserUrl(nextUrl)
            if (activeBrowserTabId) {
              setBrowserTabs((prev) => prev.map((tab) => (tab.id === activeBrowserTabId ? { ...tab, url: nextUrl, title: nextUrl } : tab)))
            }
          }} className="flex-1 rounded border border-border bg-secondary px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary" placeholder="https://example.com" />
          <button onClick={() => { setBrowserOpenError(null); try { window.open(browserUrl, '_blank', 'noopener,noreferrer') } catch (err) { setBrowserOpenError(err instanceof Error ? err.message : 'failed') } }} className="rounded bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">Open</button>
        </div>
        {browserOpenError && <div className="text-xs text-destructive">{browserOpenError}</div>}
        <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="rounded border border-border bg-secondary/50 p-2">
            <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Tabs</div>
            <div className="space-y-0.5">
              {browserTabs.map((tab) => (
                <div key={tab.id} className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs ${activeBrowserTabId === tab.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}`}>
                  <button onClick={() => { setActiveBrowserTabId(tab.id); setBrowserUrl(tab.url) }} className="min-w-0 flex-1 text-left">
                    <span className="block truncate font-medium">{tab.title}</span>
                    <span className="text-[10px] text-muted-foreground/60">{tab.url}</span>
                  </button>
                  <button onClick={() => { const next = browserTabs.filter((item) => item.id !== tab.id); setBrowserTabs(next); if (activeBrowserTabId === tab.id) setActiveBrowserTabId(next[0]?.id ?? null) }} className="rounded px-1.5 py-0.5 text-muted-foreground/60 hover:bg-secondary hover:text-foreground">x</button>
                </div>
              ))}
              {browserTabs.length === 0 && <div className="px-2.5 py-1.5 text-xs text-muted-foreground">No tabs</div>}
            </div>
          </div>
          <div className="min-h-[70vh] overflow-hidden rounded border border-border bg-background">
            {browserTabs.find((tab) => tab.id === activeBrowserTabId) ? (
              <iframe
                title="Termul Browser"
                src={browserTabs.find((tab) => tab.id === activeBrowserTabId)?.url}
                onLoad={(e) => {
                  const iframe = e.currentTarget
                  const activeTab = browserTabs.find((tab) => tab.id === activeBrowserTabId)
                  if (!activeTab) return
                  let nextTitle = activeTab.title
                  try {
                    nextTitle = iframe.contentDocument?.title || new URL(activeTab.url, window.location.href).hostname || activeTab.url
                  } catch {
                    nextTitle = new URL(activeTab.url, window.location.href).hostname || activeTab.url
                  }
                  setBrowserTabs((prev) => prev.map((tab) => (tab.id === activeTab.id ? { ...tab, title: nextTitle } : tab)))
                }}
                className="h-[70vh] w-full border-0 bg-white"
              />
            ) : (
              <div className="flex h-[70vh] items-center justify-center text-sm text-muted-foreground">Open a tab first</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function GitPanel({ ws }: { ws: WsAdapter }): React.JSX.Element {
  const [items, setItems] = useState<Array<{ id: string; cwd?: string; branch?: string | null; gitStatus?: { changedFiles?: number; stagedFiles?: number; untrackedFiles?: number; aheadBehind?: { ahead?: number; behind?: number } } }>>([])

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const terminals = await ws.invoke<Array<{ id: string; cwd?: string; gitBranch?: string | null; gitStatus?: { changedFiles?: number; stagedFiles?: number; untrackedFiles?: number; aheadBehind?: { ahead?: number; behind?: number } } }>>('terminal_list')
        if (!mounted) return
        setItems(terminals.map((t) => ({ id: t.id, cwd: t.cwd, branch: t.gitBranch ?? null, gitStatus: t.gitStatus })))
      } catch {
        if (mounted) setItems([])
      }
    }
    void load()
    const interval = window.setInterval(() => { void load() }, 4000)
    return () => { mounted = false; window.clearInterval(interval) }
  }, [ws])

  return <div className="h-full overflow-auto p-6 text-foreground"><div className="mx-auto max-w-4xl space-y-2">{items.map((item) => <div key={item.id} className="rounded border border-border bg-card p-4"><div className="flex items-center justify-between"><div className="text-sm font-semibold">{item.id}</div><div className="flex items-center gap-2"><div className="text-xs text-muted-foreground">{item.branch || 'no branch'}</div><button onClick={() => void ws.invoke('terminal_list')} className="rounded border border-border px-2 py-1 text-[11px] hover:bg-secondary">Refresh</button></div></div><div className="mt-1.5 text-[11px] text-muted-foreground">{item.cwd || 'cwd unknown'}</div><div className="mt-2.5 grid grid-cols-3 gap-1.5 text-[11px]"><div className="rounded bg-secondary px-2 py-1">Changed {item.gitStatus?.changedFiles ?? 0}</div><div className="rounded bg-secondary px-2 py-1">Staged {item.gitStatus?.stagedFiles ?? 0}</div><div className="rounded bg-secondary px-2 py-1">Untracked {item.gitStatus?.untrackedFiles ?? 0}</div></div><div className="mt-2 text-[11px] text-muted-foreground">Ahead {item.gitStatus?.aheadBehind?.ahead ?? 0} / Behind {item.gitStatus?.aheadBehind?.behind ?? 0}</div></div>)}{items.length === 0 && <div className="text-muted-foreground text-sm">No terminal data</div>}</div></div>
}

export function TunnelPanel({ ws, remoteStatus }: { ws: WsAdapter; remoteStatus: { httpUrl: string; wsUrl: string; clientCount: number } | null }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [authToken, setAuthToken] = useState('')
  const url = remoteStatus?.httpUrl || remoteStatus?.wsUrl || ''
  return (
    <div className="flex h-full items-start justify-center p-6 text-foreground">
      <div className="w-full max-w-2xl space-y-4 rounded border border-border bg-card p-6">
        <div className="flex items-center justify-between">
          <div className="text-base font-semibold">Tunnel</div>
          <div className={`rounded px-2 py-0.5 text-[11px] font-medium ${remoteStatus ? 'bg-green-500/15 text-green-400' : 'bg-secondary text-muted-foreground'}`}>{remoteStatus ? `${remoteStatus.clientCount} client` : 'offline'}</div>
        </div>
        <div className="text-xs text-muted-foreground">Status server + tunnel URL.</div>
        <div className="rounded border border-border bg-secondary p-3 text-sm font-mono">{url}</div>
        <div className="flex gap-2">
          <button onClick={async () => { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 1200) }} className="rounded bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90">{copied ? 'Copied' : 'Copy URL'}</button>
          <button onClick={() => void ws.invoke('ws_server_get_status')} className="rounded border border-border px-4 py-1.5 text-sm hover:bg-secondary">Refresh</button>
        </div>
        <div className="rounded border border-border bg-secondary/50 p-4">
          <div className="mb-2 text-sm font-medium">Server</div>
          <div className="mb-2 text-[11px] text-muted-foreground">Start/stop may work if ws server commands exposed.</div>
          <input value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder="token" className="mb-3 w-full rounded border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary" />
          <div className="flex gap-2">
            <button onClick={async () => { setBusy(true); try { await ws.invoke('ws_server_start', { port: 9876, authToken, useHttps: false }); await ws.invoke('ws_server_get_status') } finally { setBusy(false) } }} disabled={busy} className="rounded bg-green-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-60">{busy ? 'Working' : 'Start'}</button>
            <button onClick={async () => { setBusy(true); try { await ws.invoke('ws_server_stop'); await ws.invoke('ws_server_get_status') } finally { setBusy(false) } }} disabled={busy} className="rounded bg-destructive px-4 py-1.5 text-sm font-medium text-destructive-foreground disabled:opacity-60">{busy ? 'Working' : 'Stop'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
