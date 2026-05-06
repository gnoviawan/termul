import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useBrowserSessionStore } from "@/stores/browser-session-store";
import { useAnnotationStore, normalizeUrl, EMPTY_ANNOTATION_ARRAY } from "@/stores/annotation-store";
import { useShallow } from "zustand/shallow";
import { browserTabGoBack, browserTabGoForward, browserTabReload, browserTabHide, browserTabShow } from "@/lib/browser-api";
import { ArrowLeft, ArrowRight, RotateCcw, Globe, Loader2, Pencil } from "lucide-react";
import { AnnotationToolbar } from "./AnnotationToolbar";
import { AnnotationExportModal } from "./AnnotationExportModal";

interface BrowserControlsProps {
  browserTabId: string;
  annotationOverlayAvailable: boolean;
}

export function BrowserControls({
  browserTabId,
  annotationOverlayAvailable,
}: BrowserControlsProps): React.JSX.Element {
  const tab = useBrowserSessionStore(
    useShallow((state) => state.tabs.get(browserTabId))
  );
  const [inputUrl, setInputUrl] = useState(tab?.url || "");
  const [exportOpen, setExportOpen] = useState(false);
  const webviewWasVisibleRef = useRef(false);

  // Toggle export modal with webview hide/show to prevent native webview
  // from painting above the modal (same pattern as terminal menu dropdown).
  const handleOpenExport = useCallback(() => {
    // Hide the webview so the export modal is not occluded
    browserTabHide(browserTabId)
      .then((result) => {
        if (result.success) {
          webviewWasVisibleRef.current = true;
        }
      })
      .catch(console.error);
    setExportOpen(true);
  }, [browserTabId]);

  const handleCloseExport = useCallback((open: boolean) => {
    setExportOpen(open);
    if (!open && webviewWasVisibleRef.current) {
      browserTabShow(browserTabId).catch(console.error);
      webviewWasVisibleRef.current = false;
    }
  }, [browserTabId]);

  // Sync inputUrl with store URL changes (e.g. from real-time sync)
  useEffect(() => {
    if (tab?.url) {
      setInputUrl(tab.url);
    }
  }, [tab?.url]);

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
    const currentMode = tab?.annotationMode ?? false;
    useBrowserSessionStore.getState().setAnnotationMode(browserTabId, !currentMode);
  }, [browserTabId, tab?.annotationMode]);

  const handleChangeAnnotationSubMode = useCallback((mode: "draw" | "select") => {
    useBrowserSessionStore.getState().setAnnotationSubMode(browserTabId, mode);
  }, [browserTabId]);

  const handleAddNote = useCallback(() => {
    if (!tab) return;
    const url = tab.url;
    const normalizedUrl = normalizeUrl(url);
    const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1920;
    const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 1080;

    useAnnotationStore.getState().addAnnotation({
      browserTabId,
      url,
      normalizedUrl,
      pageTitle: tab.title || "",
      type: "note",
      geometry: { type: "point", x: 0, y: 0 },
      intent: "question",
      severity: "suggestion",
      description: "",
      viewportWidth,
      viewportHeight,
    });
  }, [browserTabId, tab]);

  const annotations = useAnnotationStore(
    useShallow((state) => {
      if (!tab) return EMPTY_ANNOTATION_ARRAY;
      return state.getAnnotationsForUrl(tab.url);
    })
  );

  if (!tab) return <></>;

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
          {tab.loading ? (
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
            tab.annotationMode
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "hover:bg-secondary text-muted-foreground hover:text-foreground"
          )}
          title={tab.annotationMode ? "Disable annotation mode" : "Enable annotation mode"}
        >
          <Pencil size={14} />
        </button>
      </div>

      {tab.annotationMode && (
        <AnnotationToolbar
          annotationMode={tab.annotationMode}
          annotationSubMode={tab.annotationSubMode}
          annotationOverlayAvailable={annotationOverlayAvailable}
          hasAnnotations={annotations.length > 0}
          onToggleAnnotationMode={handleToggleAnnotationMode}
          onChangeAnnotationSubMode={handleChangeAnnotationSubMode}
          onAddNote={handleAddNote}
          onExport={handleOpenExport}
        />
      )}

      <AnnotationExportModal
        open={exportOpen}
        onOpenChange={handleCloseExport}
        annotations={annotations}
      />
    </div>
  );
}
