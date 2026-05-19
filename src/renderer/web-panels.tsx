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
    <div className="flex h-full items-start justify-center p-6 text-zinc-200">
      <div className="w-full max-w-6xl space-y-4 rounded-3xl border border-zinc-800 bg-zinc-950 p-6">
        <div className="text-lg font-semibold">Browser</div>
        <div className="flex gap-2">
          <input value={browserUrl} onChange={(e) => {
            const nextUrl = e.target.value
            setBrowserUrl(nextUrl)
            if (activeBrowserTabId) {
              setBrowserTabs((prev) => prev.map((tab) => (tab.id === activeBrowserTabId ? { ...tab, url: nextUrl, title: nextUrl } : tab)))
            }
          }} className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm outline-none" placeholder="https://example.com" />
          <button onClick={() => { setBrowserOpenError(null); try { window.open(browserUrl, '_blank', 'noopener,noreferrer') } catch (err) { setBrowserOpenError(err instanceof Error ? err.message : 'failed') } }} className="rounded-xl bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500">Open</button>
        </div>
        {browserOpenError && <div className="text-xs text-red-400">{browserOpenError}</div>}
        <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-2">
            <div className="mb-2 px-2 text-xs uppercase tracking-wider text-zinc-500">Tabs</div>
            <div className="space-y-1">
              {browserTabs.map((tab) => (
                <div key={tab.id} className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm ${activeBrowserTabId === tab.id ? 'bg-blue-600 text-white' : 'bg-zinc-950 hover:bg-zinc-800'}`}>
                  <button onClick={() => { setActiveBrowserTabId(tab.id); setBrowserUrl(tab.url) }} className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{tab.title}</span>
                    <span className="text-xs opacity-70">{tab.url}</span>
                  </button>
                  <button onClick={() => { const next = browserTabs.filter((item) => item.id !== tab.id); setBrowserTabs(next); if (activeBrowserTabId === tab.id) setActiveBrowserTabId(next[0]?.id ?? null) }} className="rounded-lg px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800">x</button>
                </div>
              ))}
              {browserTabs.length === 0 && <div className="px-3 py-2 text-sm text-zinc-500">No tab</div>}
            </div>
          </div>
          <div className="min-h-[70vh] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">
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
              <div className="flex h-[70vh] items-center justify-center text-sm text-zinc-500">Open tab first</div>
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

  return <div className="h-full overflow-auto p-6 text-zinc-200"><div className="mx-auto max-w-4xl space-y-3">{items.map((item) => <div key={item.id} className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4"><div className="flex items-center justify-between"><div className="font-semibold">{item.id}</div><div className="flex items-center gap-2"><div className="text-sm text-zinc-400">{item.branch || 'no branch'}</div><button onClick={() => void ws.invoke('terminal_list')} className="rounded-lg border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-900">Refresh</button></div></div><div className="mt-2 text-xs text-zinc-500">{item.cwd || 'cwd unknown'}</div><div className="mt-3 grid grid-cols-3 gap-2 text-xs"><div className="rounded-lg bg-zinc-900 px-2 py-1">Changed {item.gitStatus?.changedFiles ?? 0}</div><div className="rounded-lg bg-zinc-900 px-2 py-1">Staged {item.gitStatus?.stagedFiles ?? 0}</div><div className="rounded-lg bg-zinc-900 px-2 py-1">Untracked {item.gitStatus?.untrackedFiles ?? 0}</div></div><div className="mt-3 text-xs text-zinc-500">Ahead {item.gitStatus?.aheadBehind?.ahead ?? 0} / Behind {item.gitStatus?.aheadBehind?.behind ?? 0}</div></div>)}{items.length === 0 && <div className="text-zinc-500">No terminal data</div>}</div></div>
}

export function TunnelPanel({ ws, remoteStatus }: { ws: WsAdapter; remoteStatus: { httpUrl: string; wsUrl: string; clientCount: number } | null }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [authToken, setAuthToken] = useState('')
  const url = remoteStatus?.httpUrl || remoteStatus?.wsUrl || ''
  return <div className="flex h-full items-start justify-center p-6 text-zinc-200"><div className="w-full max-w-2xl space-y-4 rounded-3xl border border-zinc-800 bg-zinc-950 p-6"><div className="flex items-center justify-between"><div className="text-lg font-semibold">Tunnel</div><div className={`rounded-full px-3 py-1 text-xs ${remoteStatus ? 'bg-emerald-500/15 text-emerald-300' : 'bg-zinc-800 text-zinc-400'}`}>{remoteStatus ? `${remoteStatus.clientCount} client` : 'offline'}</div></div><div className="text-sm text-zinc-400">Status server + tunnel URL.</div><div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-4 text-sm">{url}</div><div className="flex gap-2"><button onClick={async () => { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 1200) }} className="rounded-xl bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500">{copied ? 'Copied' : 'Copy URL'}</button><button onClick={() => void ws.invoke('ws_server_get_status')} className="rounded-xl border border-zinc-700 px-4 py-2 hover:bg-zinc-900">Refresh</button></div><div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-4"><div className="mb-2 text-sm font-medium">Server</div><div className="mb-3 text-xs text-zinc-500">Start/stop may work if ws server commands exposed to web socket.</div><input value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder="token" className="mb-3 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none" /><div className="flex gap-2"><button onClick={async () => { setBusy(true); try { await ws.invoke('ws_server_start', { port: 9876, authToken, useHttps: false }); await ws.invoke('ws_server_get_status') } finally { setBusy(false) } }} disabled={busy} className="rounded-xl bg-emerald-600 px-4 py-2 font-medium text-white disabled:opacity-60">{busy ? 'Working' : 'Start'}</button><button onClick={async () => { setBusy(true); try { await ws.invoke('ws_server_stop'); await ws.invoke('ws_server_get_status') } finally { setBusy(false) } }} disabled={busy} className="rounded-xl bg-red-600 px-4 py-2 font-medium text-white disabled:opacity-60">{busy ? 'Working' : 'Stop'}</button></div></div></div></div>
}
