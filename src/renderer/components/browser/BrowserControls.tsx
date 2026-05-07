import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useBrowserSessionStore } from "@/stores/browser-session-store";
import { browserTabGoBack, browserTabGoForward, browserTabReload } from "@/lib/browser-api";
import { ArrowLeft, ArrowRight, RotateCcw, Globe, Loader2, Pencil } from "lucide-react";

interface BrowserControlsProps {
  browserTabId: string;
}

export function BrowserControls({
  browserTabId,
}: BrowserControlsProps): React.JSX.Element {
  const tabUrl = useBrowserSessionStore(
    (state) => state.tabs.get(browserTabId)?.url ?? ''
  );
  const tabLoading = useBrowserSessionStore(
    (state) => state.tabs.get(browserTabId)?.loading ?? false
  );
  const tabAnnotationMode = useBrowserSessionStore(
    (state) => state.tabs.get(browserTabId)?.annotationMode ?? false
  );
  const [inputUrl, setInputUrl] = useState(tabUrl || "");

  // Sync inputUrl with store URL changes (e.g. from real-time sync)
  useEffect(() => {
    if (tabUrl) {
      setInputUrl(tabUrl);
    }
  }, [tabUrl]);

  const handleNavigate = useCallback(() => {
    let url = inputUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url) && !/^about:/i.test(url)) {
      url = "https://" + url;
    }
    useBrowserSessionStore.getState().updateUrl(browserTabId, url);
  }, [browserTabId, inputUrl]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleNavigate();
      }
    },
    [handleNavigate]
  );

  const handleToggleAnnotationMode = useCallback(() => {
    const currentMode = tabAnnotationMode;
    useBrowserSessionStore.getState().setAnnotationMode(browserTabId, !currentMode);
  }, [browserTabId, tabAnnotationMode]);

  if (!tabUrl) return <></>;

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
        <button
          onClick={handleToggleAnnotationMode}
          className={cn(
            "p-1.5 rounded transition-colors shrink-0",
            tabAnnotationMode
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "hover:bg-secondary text-muted-foreground hover:text-foreground"
          )}
          title={tabAnnotationMode ? "Disable annotation mode" : "Enable annotation mode"}
        >
          <Pencil size={14} />
        </button>
      </div>
    </div>
  );
}
