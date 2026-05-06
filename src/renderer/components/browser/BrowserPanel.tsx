import { useEffect, useRef } from "react";
import { useBrowserWebview } from "@/hooks/use-browser-webview";
import { useBrowserSessionStore } from "@/stores/browser-session-store";
import { useAnnotationCapture } from "@/hooks/use-annotation-capture";
import { BrowserControls } from "./BrowserControls";
import { AnnotationPanel } from "./AnnotationPanel";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import {
  browserTabInjectAnnotation,
  browserTabRemoveAnnotationOverlay,
  onBrowserTabTitleChanged,
  onBrowserTabLoaded,
} from "@/lib/browser-api";
import { toast } from "sonner";
import { useShallow } from "zustand/shallow";

interface BrowserPanelProps {
  browserTabId: string;
  isVisible: boolean;
}

const DEFAULT_URL = "https://www.google.com";

export function BrowserPanel({ browserTabId, isVisible }: BrowserPanelProps): React.JSX.Element {
  const tab = useBrowserSessionStore(
    useShallow((state) => state.tabs.get(browserTabId))
  );
  const url = tab?.url || DEFAULT_URL;
  const loading = tab?.loading ?? false;
  const annotationMode = tab?.annotationMode ?? false;

  const { containerRef } = useBrowserWebview(browserTabId, isVisible, url);
  const injectedRef = useRef(false);

  // Subscribe to region-captured events
  useAnnotationCapture(browserTabId);

  // Listen for title changes and update store
  useEffect(() => {
    const subscription = onBrowserTabTitleChanged((payload) => {
      if (payload.browserTabId === browserTabId) {
        useBrowserSessionStore.getState().updateTitle(browserTabId, payload.title);
      }
    });
    return () => subscription.unlisten();
  }, [browserTabId]);

  // Handle annotation overlay lifecycle
  useEffect(() => {
    if (!isVisible) return;

    const injectIfReady = async () => {
      if (annotationMode && !loading) {
        const result = await browserTabInjectAnnotation(browserTabId);
        if (result.success) {
          injectedRef.current = true;
        } else {
          toast.error("Annotation mode is not available on this page due to security policies");
        }
      }
    };

    injectIfReady();

    return () => {
      if (injectedRef.current) {
        browserTabRemoveAnnotationOverlay(browserTabId).catch(console.error);
        injectedRef.current = false;
      }
    };
  }, [annotationMode, loading, browserTabId, isVisible]);

  // Re-inject overlay when page loads while annotation mode is enabled
  useEffect(() => {
    const subscription = onBrowserTabLoaded(async (payload) => {
      if (payload.browserTabId !== browserTabId) return;
      if (annotationMode && isVisible) {
        const result = await browserTabInjectAnnotation(browserTabId);
        if (result.success) {
          injectedRef.current = true;
        }
      }
    });
    return () => subscription.unlisten();
  }, [annotationMode, browserTabId, isVisible]);

  return (
    <div
      className={cn(
        "w-full h-full flex flex-col",
        isVisible ? "visible" : "invisible absolute inset-0"
      )}
    >
      {isVisible && <BrowserControls browserTabId={browserTabId} />}
      <div className="flex flex-1 overflow-hidden">
        <div ref={containerRef} className="flex-1 bg-background relative">
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80 z-10">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="mt-2 text-sm text-muted-foreground">Loading...</span>
            </div>
          )}
        </div>
        {annotationMode && (
          <AnnotationPanel browserTabId={browserTabId} url={url} />
        )}
      </div>
    </div>
  );
}
