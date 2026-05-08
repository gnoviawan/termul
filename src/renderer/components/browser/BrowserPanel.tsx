import { useCallback, useEffect, useRef, useState } from "react";
import { useBrowserWebview } from "@/hooks/use-browser-webview";
import { useBrowserSessionStore, type AnnotationSubMode } from "@/stores/browser-session-store";
import { useAnnotationCapture } from "@/hooks/use-annotation-capture";
import { useAnnotationMarkers } from "@/hooks/use-annotation-markers";
import { useAnnotationStore, normalizeUrl, EMPTY_ANNOTATION_ARRAY } from "@/stores/annotation-store";
import { useShallow } from "zustand/shallow";
import { BrowserControls } from "./BrowserControls";
import { AnnotationPanel } from "./AnnotationPanel";
import { AnnotationExportModal } from "./AnnotationExportModal";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import {
  browserTabInjectAnnotation,
  browserTabRemoveAnnotationOverlay,
  browserTabHide,
  browserTabShow,
  onBrowserTabTitleChanged,
  onBrowserTabLoaded,
} from "@/lib/browser-api";
import { toast } from "sonner";

interface BrowserPanelProps {
  browserTabId: string;
  isVisible: boolean;
}

const DEFAULT_URL = "https://www.google.com";
const ANNOTATION_UNAVAILABLE_MESSAGE = "Annotation mode is not available on this page due to security policies";

export function BrowserPanel({ browserTabId, isVisible }: BrowserPanelProps): React.JSX.Element {
  const url = useBrowserSessionStore(
    (state) => state.tabs.get(browserTabId)?.url || DEFAULT_URL
  );
  const tabTitle = useBrowserSessionStore(
    (state) => state.tabs.get(browserTabId)?.title ?? ''
  );
  const loading = useBrowserSessionStore(
    (state) => state.tabs.get(browserTabId)?.loading ?? false
  );
  const annotationMode = useBrowserSessionStore(
    (state) => state.tabs.get(browserTabId)?.annotationMode ?? false
  );
  const annotationSubMode = useBrowserSessionStore(
    (state) => state.tabs.get(browserTabId)?.annotationSubMode ?? "draw"
  );

  const [exportOpen, setExportOpen] = useState(false);
  const webviewWasVisibleRef = useRef(false);

  const annotations = useAnnotationStore(
    useShallow((state) => {
      if (!url) return EMPTY_ANNOTATION_ARRAY;
      return state.getAnnotationsForUrl(url);
    })
  );

  const handleAddNote = useCallback(() => {
    if (!url) return;
    const normalizedUrl = normalizeUrl(url);
    const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1920;
    const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 1080;

    useAnnotationStore.getState().addAnnotation({
      browserTabId,
      url,
      normalizedUrl,
      pageTitle: tabTitle || "",
      type: "note",
      geometry: { type: "point", x: 0, y: 0 },
      intent: "question",
      severity: "suggestion",
      description: "",
      viewportWidth,
      viewportHeight,
    });
  }, [browserTabId, url, tabTitle]);

  const handleOpenExport = useCallback(() => {
    if (exportOpen) return;
    browserTabHide(browserTabId)
      .then((result) => {
        if (result.success) {
          webviewWasVisibleRef.current = true;
        }
      })
      .catch(console.error);
    setExportOpen(true);
  }, [browserTabId, exportOpen]);

  const handleCloseExport = useCallback((open: boolean) => {
    setExportOpen(open);
    if (!open && webviewWasVisibleRef.current) {
      if (isVisible) {
        browserTabShow(browserTabId).catch(console.error);
      }
      webviewWasVisibleRef.current = false;
    }
  }, [browserTabId, isVisible]);

  const handleExitAnnotationMode = useCallback(() => {
    useBrowserSessionStore.getState().setAnnotationMode(browserTabId, false);
  }, [browserTabId]);

  const handleChangeAnnotationSubMode = useCallback((mode: AnnotationSubMode) => {
    useBrowserSessionStore.getState().setAnnotationSubMode(browserTabId, mode);
  }, [browserTabId]);

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
        <BrowserControls browserTabId={browserTabId} />
      )}
      <div className="flex flex-1 overflow-hidden">
        <div ref={containerRef} className="flex-1 bg-background relative">
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80 z-10 motion-safe:animate-fade-in">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="mt-2 text-sm text-muted-foreground">Loading...</span>
            </div>
          )}
        </div>
        {annotationMode && (
          <AnnotationPanel
            url={url}
            annotationSubMode={annotationSubMode}
            annotationOverlayAvailable={annotationOverlayAvailable}
            onExitAnnotationMode={handleExitAnnotationMode}
            onChangeAnnotationSubMode={handleChangeAnnotationSubMode}
            onAddNote={handleAddNote}
            onExport={handleOpenExport}
          />
        )}
      </div>
      <AnnotationExportModal
        open={exportOpen}
        onOpenChange={handleCloseExport}
        annotations={annotations}
      />
    </div>
  );
}
