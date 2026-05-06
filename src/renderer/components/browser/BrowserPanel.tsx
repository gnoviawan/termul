import { useBrowserWebview } from "@/hooks/use-browser-webview";
import { useBrowserSessionStore } from "@/stores/browser-session-store";
import { BrowserControls } from "./BrowserControls";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

interface BrowserPanelProps {
  browserTabId: string;
  isVisible: boolean;
}

const DEFAULT_URL = "https://www.google.com";

export function BrowserPanel({ browserTabId, isVisible }: BrowserPanelProps): React.JSX.Element {
  const tab = useBrowserSessionStore((state) => state.tabs.get(browserTabId));
  const url = tab?.url || DEFAULT_URL;
  const loading = tab?.loading ?? false;

  const { containerRef } = useBrowserWebview(browserTabId, isVisible, url);

  return (
    <div
      className={cn(
        "w-full h-full flex flex-col",
        isVisible ? "visible" : "invisible absolute inset-0"
      )}
    >
      {isVisible && <BrowserControls browserTabId={browserTabId} />}
      <div ref={containerRef} className="flex-1 bg-background relative">
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80 z-10">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="mt-2 text-sm text-muted-foreground">Loading...</span>
          </div>
        )}
      </div>
    </div>
  );
}
