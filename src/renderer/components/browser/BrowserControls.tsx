import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";
import { useBrowserSessionStore } from "@/stores/browser-session-store";
import { browserTabNavigate, browserTabGoBack, browserTabGoForward, browserTabReload } from "@/lib/browser-api";
import { ArrowLeft, ArrowRight, RotateCcw, Globe } from "lucide-react";

interface BrowserControlsProps {
  browserTabId: string;
}

export function BrowserControls({ browserTabId }: BrowserControlsProps): React.JSX.Element {
  const tab = useBrowserSessionStore((state) => state.tabs.get(browserTabId));
  const [inputUrl, setInputUrl] = useState(tab?.url || "");

  const handleNavigate = useCallback(() => {
    let url = inputUrl.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url) && !/^about:/i.test(url)) {
      url = "https://" + url;
    }
    browserTabNavigate(browserTabId, url)
      .then((result) => {
        if (result.success) {
          useBrowserSessionStore.getState().updateUrl(browserTabId, url);
        } else {
          console.error('[BrowserControls] navigate failed:', result.error);
        }
      })
      .catch(console.error);
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

  if (!tab) return <></>;

  return (
    <div className="h-9 flex items-center gap-1.5 px-2 bg-card border-b border-border shrink-0">
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
        <Globe size={14} className="text-muted-foreground shrink-0" />
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
    </div>
  );
}
