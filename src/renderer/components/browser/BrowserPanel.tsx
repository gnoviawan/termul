import { Loader2 } from 'lucide-react'
import { useEffect } from 'react'
import { useBrowserWebview } from '@/hooks/use-browser-webview'
import { onBrowserTabTitleChanged } from '@/lib/browser-api'
import { cn } from '@/lib/utils'
import { useBrowserSessionStore } from '@/stores/browser-session-store'
import { BrowserControls } from './BrowserControls'

interface BrowserPanelProps {
  browserTabId: string
  isVisible: boolean
}

const DEFAULT_URL = 'https://www.google.com'

export function BrowserPanel({ browserTabId, isVisible }: BrowserPanelProps): React.JSX.Element {
  const url = useBrowserSessionStore((state) => state.tabs.get(browserTabId)?.url || DEFAULT_URL)
  const loading = useBrowserSessionStore((state) => state.tabs.get(browserTabId)?.loading ?? false)

  // Visibility is owned solely by useBrowserWebview — it serializes
  // show/hide after create and inspects IpcResult.success.
  const { containerRef } = useBrowserWebview(browserTabId, isVisible, url)

  // Listen for title changes and update store
  useEffect(() => {
    const subscription = onBrowserTabTitleChanged((payload) => {
      if (payload.browserTabId === browserTabId) {
        useBrowserSessionStore.getState().updateTitle(browserTabId, payload.title)
      }
    })
    return () => subscription.unlisten()
  }, [browserTabId])

  return (
    <div
      className={cn(
        'w-full h-full flex flex-col',
        isVisible ? 'visible' : 'invisible absolute inset-0'
      )}
    >
      {isVisible && <BrowserControls browserTabId={browserTabId} />}
      <div className="flex flex-1 overflow-hidden">
        <div ref={containerRef} className="flex-1 bg-background relative">
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80 z-10 motion-safe:animate-fade-in">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="mt-2 text-sm text-muted-foreground">Loading...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
