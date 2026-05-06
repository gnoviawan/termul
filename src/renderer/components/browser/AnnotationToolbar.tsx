import { Pencil, StickyNote, FileDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface AnnotationToolbarProps {
  annotationMode: boolean;
  hasAnnotations: boolean;
  onToggleAnnotationMode: () => void;
  onAddNote: () => void;
  onExport: () => void;
}

export function AnnotationToolbar({
  annotationMode,
  hasAnnotations,
  onToggleAnnotationMode,
  onAddNote,
  onExport,
}: AnnotationToolbarProps): React.JSX.Element {
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
