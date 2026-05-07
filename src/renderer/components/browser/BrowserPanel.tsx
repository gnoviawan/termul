import { useEffect, useRef, useState } from "react";
import { useBrowserWebview } from "@/hooks/use-browser-webview";
import { useBrowserSessionStore, type AnnotationSubMode } from "@/stores/browser-session-store";
import { useAnnotationCapture } from "@/hooks/use-annotation-capture";
import { useAnnotationMarkers } from "@/hooks/use-annotation-markers";
import { BrowserControls } from "./BrowserControls";
import { AnnotationPanel } from "./AnnotationPanel";
import { normalizeUrl } from "@/stores/annotation-store";
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
const ANNOTATION_UNAVAILABLE_MESSAGE = "Annotation mode is not available on this page due to security policies";

export function BrowserPanel({ browserTabId, isVisible }: BrowserPanelProps): React.JSX.Element {
  const tab = useBrowserSessionStore(
    useShallow((state) => state.tabs.get(browserTabId))
  );
  const url = tab?.url || DEFAULT_URL;
  const loading = tab?.loading ?? false;
  const annotationMode = tab?.annotationMode ?? false;
  const annotationSubMode = tab?.annotationSubMode ?? "draw";

  const { containerRef } = useBrowserWebview(browserTabId, isVisible, url);
  const injectedModeRef = useRef<AnnotationSubMode | null>(null);
  const [annotationOverlayAvailable, setAnnotationOverlayAvailable] = useState(true);

  // Subscribe to annotation capture events
  useAnnotationCapture(browserTabId);

  // Mount annotation markers hook
  useAnnotationMarkers(browserTabId, isVisible, normalizeUrl(url));

  // Listen for title changes and update store
  useEffect(() => {
    const subscription = onBrowserTabTitleChanged((payload) => {
      if (payload.browserTabId === browserTabId) {
        useBrowserSessionStore.getState().updateTitle(browserTabId, payload.title);
      }
    });
    return () => subscription.unlisten();
  }, [browserTabId]);

  useEffect(() => {
    let cancelled = false;

    const removeOverlayIfNeeded = async () => {
      if (!injectedModeRef.current) return;
      await browserTabRemoveAnnotationOverlay(browserTabId).catch(console.error);
      if (!cancelled) {
        injectedModeRef.current = null;
      }
    };

    const ensureOverlay = async (targetMode: AnnotationSubMode, allowRollback: boolean) => {
      const previousMode = injectedModeRef.current;
      const modeChanged = previousMode !== null && previousMode !== targetMode;

      if (modeChanged) {
        await browserTabRemoveAnnotationOverlay(browserTabId).catch(console.error);
        if (cancelled) return;
        injectedModeRef.current = null;
      }

      const result = await browserTabInjectAnnotation(browserTabId, targetMode);
      if (cancelled) return;

      if (result.success) {
        injectedModeRef.current = targetMode;
        setAnnotationOverlayAvailable(true);
        return;
      }

      setAnnotationOverlayAvailable(false);
      toast.error(ANNOTATION_UNAVAILABLE_MESSAGE);

      if (modeChanged && allowRollback && previousMode) {
        useBrowserSessionStore.getState().setAnnotationSubMode(browserTabId, previousMode);
      }
    };

    if (!annotationMode || !isVisible) {
      void removeOverlayIfNeeded();
      return () => {
        cancelled = true;
      };
    }

    if (loading) {
      return () => {
        cancelled = true;
      };
    }

    if (injectedModeRef.current === annotationSubMode) {
      setAnnotationOverlayAvailable(true);
      return () => {
        cancelled = true;
      };
    }

    void ensureOverlay(annotationSubMode, true);

    return () => {
      cancelled = true;
    };
  }, [annotationMode, annotationSubMode, loading, browserTabId, isVisible]);

  // Re-inject overlay when page loads while annotation mode is enabled
  useEffect(() => {
    const subscription = onBrowserTabLoaded(async (payload) => {
      if (payload.browserTabId !== browserTabId) return;
      injectedModeRef.current = null;

      if (annotationMode && isVisible) {
        await browserTabRemoveAnnotationOverlay(browserTabId).catch(console.error);
        const result = await browserTabInjectAnnotation(browserTabId, annotationSubMode);
        if (result.success) {
          injectedModeRef.current = annotationSubMode;
          setAnnotationOverlayAvailable(true);
        } else {
          setAnnotationOverlayAvailable(false);
          toast.error(ANNOTATION_UNAVAILABLE_MESSAGE);
        }
      }
    });
    return () => subscription.unlisten();
  }, [annotationMode, annotationSubMode, browserTabId, isVisible]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (injectedModeRef.current) {
        browserTabRemoveAnnotationOverlay(browserTabId).catch(console.error);
        injectedModeRef.current = null;
      }
    };
  }, [browserTabId]);

  return (
    <div
      className={cn(
        "w-full h-full flex flex-col",
        isVisible ? "visible" : "invisible absolute inset-0"
      )}
    >
      {isVisible && (
        <BrowserControls
          browserTabId={browserTabId}
          annotationOverlayAvailable={annotationOverlayAvailable}
        />
      )}
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
