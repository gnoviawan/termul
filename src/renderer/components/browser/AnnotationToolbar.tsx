import { Pencil, StickyNote, FileDown, X, Square, Crosshair } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AnnotationSubMode } from "@/stores/browser-session-store";

interface AnnotationToolbarProps {
  annotationMode: boolean;
  annotationSubMode: AnnotationSubMode;
  annotationOverlayAvailable: boolean;
  hasAnnotations: boolean;
  onToggleAnnotationMode: () => void;
  onChangeAnnotationSubMode: (mode: AnnotationSubMode) => void;
  onAddNote: () => void;
  onExport: () => void;
}

export function AnnotationToolbar({
  annotationMode,
  annotationSubMode,
  annotationOverlayAvailable,
  hasAnnotations,
  onToggleAnnotationMode,
  onChangeAnnotationSubMode,
  onAddNote,
  onExport,
}: AnnotationToolbarProps): React.JSX.Element {
  const selectDisabled = !annotationOverlayAvailable;

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-card border-b border-border shrink-0">
      <Button
        variant={annotationMode ? "default" : "ghost"}
        size="sm"
        onClick={onToggleAnnotationMode}
        title={annotationMode ? "Disable annotation mode" : "Enable annotation mode"}
        className={cn(
          "h-7 text-xs gap-1.5",
          annotationMode && "bg-primary text-primary-foreground"
        )}
      >
        {annotationMode ? (
          <X size={13} />
        ) : (
          <Pencil size={13} />
        )}
        {annotationMode ? "Done" : "Annotate"}
      </Button>

      <div
        role="group"
        aria-label="Annotation mode"
        className="flex items-center gap-1 rounded-md border border-border bg-background px-1 py-1"
      >
        <Button
          type="button"
          variant={annotationSubMode === "draw" ? "default" : "ghost"}
          size="sm"
          aria-pressed={annotationSubMode === "draw"}
          onClick={() => onChangeAnnotationSubMode("draw")}
          title="Draw rectangle annotations"
          className="h-7 text-xs gap-1.5"
        >
          <Square size={13} />
          Draw
        </Button>

        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                type="button"
                variant={annotationSubMode === "select" ? "default" : "ghost"}
                size="sm"
                aria-pressed={annotationSubMode === "select"}
                onClick={() => onChangeAnnotationSubMode("select")}
                disabled={selectDisabled}
                title={selectDisabled ? "Annotation unavailable on this page" : "Select elements"}
                className="h-7 text-xs gap-1.5"
              >
                <Crosshair size={13} />
                Select
              </Button>
            </span>
          </TooltipTrigger>
          {selectDisabled && (
            <TooltipContent side="bottom">
              Annotation unavailable on this page
            </TooltipContent>
          )}
        </Tooltip>
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={onAddNote}
        disabled={!annotationMode}
        title="Add page note"
        className="h-7 text-xs gap-1.5"
      >
        <StickyNote size={13} />
        Note
      </Button>

      <div className="flex-1" />

      <Button
        variant="ghost"
        size="sm"
        onClick={onExport}
        disabled={!hasAnnotations}
        title={hasAnnotations ? "Export annotations" : "No annotations to export"}
        className="h-7 text-xs gap-1.5"
      >
        <FileDown size={13} />
        Export
      </Button>
    </div>
  );
}
