import { ArrowLeft, ArrowRight, Bug, Globe, Loader2, Pencil, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  browserTabGoBack,
  browserTabGoForward,
  browserTabOpenDevtools,
  browserTabReload
} from '@/lib/browser-api'
import { cn } from '@/lib/utils'
import { useBrowserSessionStore } from '@/stores/browser-session-store'

interface BrowserControlsProps {
  browserTabId: string
}

export function BrowserControls({ browserTabId }: BrowserControlsProps): React.JSX.Element {
  const tabUrl = useBrowserSessionStore((state) => state.tabs.get(browserTabId)?.url ?? '')
  const tabLoading = useBrowserSessionStore(
    (state) => state.tabs.get(browserTabId)?.loading ?? false
  )
  const tabAnnotationMode = useBrowserSessionStore(
    (state) => state.tabs.get(browserTabId)?.annotationMode ?? false
  )
  const [inputUrl, setInputUrl] = useState(tabUrl || '')

  // Sync inputUrl with store URL changes (e.g. from real-time sync)
  useEffect(() => {
    if (tabUrl) {
      setInputUrl(tabUrl)
    }
  }, [tabUrl])

  const handleNavigate = useCallback(() => {
    let url = inputUrl.trim()
    if (!url) return
    if (!/^https?:\/\//i.test(url) && !/^about:/i.test(url)) {
      url = `https://${url}`
    }
    useBrowserSessionStore.getState().updateUrl(browserTabId, url)
  }, [browserTabId, inputUrl])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleNavigate()
      }
    },
    [handleNavigate]
  )

  const handleToggleAnnotationMode = useCallback(() => {
    const currentMode = tabAnnotationMode
    useBrowserSessionStore.getState().setAnnotationMode(browserTabId, !currentMode)
  }, [browserTabId, tabAnnotationMode])

  if (!tabUrl) return <></>

  return (
    <div className="flex flex-col shrink-0">
      <div className="h-9 flex items-center gap-1.5 px-2 bg-card border-b border-border">
        <button
          onClick={() => browserTabGoBack(browserTabId).catch(console.error)}
          className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          title="Back"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          onClick={() => browserTabGoForward(browserTabId).catch(console.error)}
          className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          title="Forward"
        >
          <ArrowRight size={14} />
        </button>
        <button
          onClick={() => browserTabReload(browserTabId).catch(console.error)}
          className="p-1.5 rounded hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          title="Reload"
        >
          <RotateCcw size={14} />
        </button>
        <div className="flex-1 flex items-center gap-2 min-w-0">
          {tabLoading ? (
            <Loader2 size={14} className="text-primary shrink-0 animate-spin" />
          ) : (
            <Globe size={14} className="text-muted-foreground shrink-0" />
          )}
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleNavigate}
            className="flex-1 bg-transparent text-sm text-foreground outline-none min-w-0"
            placeholder="Enter URL..."
          />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => browserTabOpenDevtools(browserTabId).catch(console.error)}
              className="p-1.5 rounded shrink-0 hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Open debug console"
              title="Debug Console"
            >
              <Bug size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Debug Console</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={handleToggleAnnotationMode}
              aria-pressed={tabAnnotationMode}
              className={cn(
                'p-1.5 rounded shrink-0 transition-all motion-safe:transition-[background-color,color,transform,box-shadow] motion-safe:duration-150 motion-safe:hover:scale-110 motion-safe:active:scale-95',
                tabAnnotationMode
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90 ring-2 ring-primary/30 shadow-sm shadow-primary/20'
                  : 'hover:bg-secondary text-muted-foreground hover:text-foreground'
              )}
              aria-label={tabAnnotationMode ? 'Disable annotation mode' : 'Enable annotation mode'}
            >
              <Pencil size={14} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {tabAnnotationMode ? 'Disable annotation mode' : 'Enable annotation mode'}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
