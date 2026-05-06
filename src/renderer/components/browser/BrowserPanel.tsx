import { useBrowserWebview } from "@/hooks/use-browser-webview";
import { useBrowserSessionStore } from "@/stores/browser-session-store";
import { BrowserControls } from "./BrowserControls";
import { cn } from "@/lib/utils";

interface BrowserPanelProps {
  browserTabId: string;
  isVisible: boolean;
}

export function BrowserPanel({ browserTabId, isVisible }: BrowserPanelProps): React.JSX.Element {
  const tab = useBrowserSessionStore((state) => state.tabs.get(browserTabId));
  const url = tab?.url || "about:blank";

  const { containerRef } = useBrowserWebview(browserTabId, isVisible, url);

  return (
    <div
      className={cn(
        "w-full h-full flex flex-col",
        isVisible ? "visible" : "invisible absolute inset-0"
      )}
    >
      {isVisible && <BrowserControls browserTabId={browserTabId} />}
      <div ref={containerRef} className="flex-1 bg-background" />
    </div>
  );
}
