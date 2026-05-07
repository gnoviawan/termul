import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Trash2 } from "lucide-react";
import { useAnnotationStore, type Annotation, type ElementGeometry, type Intent, type Severity, normalizeUrl } from "@/stores/annotation-store";

interface AnnotationPanelProps {
  browserTabId: string;
  url: string;
}

const intentOptions: Intent[] = ["fix", "change", "question", "approve"];
const severityOptions: Severity[] = ["blocking", "important", "suggestion"];

const severityColorClass: Record<Severity, string> = {
  blocking: "bg-red-500",
  important: "bg-amber-500",
  suggestion: "bg-blue-500",
};

const intentBadgeClass: Record<Intent, string> = {
  fix: "bg-red-100 text-red-700 border-red-200",
  change: "bg-amber-100 text-amber-700 border-amber-200",
  question: "bg-blue-100 text-blue-700 border-blue-200",
  approve: "bg-green-100 text-green-700 border-green-200",
};

const selectorConfidenceClass: Record<ElementGeometry["selectorConfidence"], string> = {
  "unique-id": "bg-green-100 text-green-800 border-green-200",
  "unique-class": "bg-orange-100 text-orange-800 border-orange-200",
  fallback: "bg-gray-100 text-gray-700 border-gray-200",
};

function truncateForDisplay(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function AnnotationElementDetails({ geometry }: { geometry: ElementGeometry }): React.JSX.Element {
  const selectorPreview = truncateForDisplay(geometry.selector, 60);
  const textPreview = truncateForDisplay(geometry.textContent, 80) || "(no text)";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">
          {`<${geometry.tagName}>`}
        </Badge>
        <Badge className={cn("text-[10px] border", selectorConfidenceClass[geometry.selectorConfidence])}>
          {geometry.selectorConfidence}
        </Badge>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="text-[11px] text-muted-foreground font-mono break-all cursor-default">
            {selectorPreview}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-md break-all text-xs font-mono">
          {geometry.selector}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="text-[11px] text-muted-foreground cursor-default whitespace-pre-wrap break-words">
            {textPreview}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-md whitespace-pre-wrap break-words text-xs">
          {geometry.textContent || "(no text)"}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

function AnnotationItem({
  annotation,
  isSelected,
  onSelect,
  onUpdate,
  onDelete,
}: {
  annotation: Annotation;
  isSelected: boolean;
  onSelect: () => void;
  onUpdate: (id: string, updates: Partial<Pick<Annotation, "intent" | "severity" | "description">>) => void;
  onDelete: (id: string) => void;
}): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const [draftDescription, setDraftDescription] = useState(annotation.description);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isSelected && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isSelected]);

  const handleSave = () => {
    onUpdate(annotation.id, { description: draftDescription });
    setIsEditing(false);
  };

  return (
    <div
      ref={cardRef}
      onClick={onSelect}
      className={cn(
        "rounded-md border border-border bg-card p-3 space-y-2 cursor-pointer transition-all",
        isSelected && "ring-2 ring-primary"
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
            intentBadgeClass[annotation.intent]
          )}
        >
          {annotation.intent}
        </span>
        <div
          className={cn("h-2 w-2 rounded-full", severityColorClass[annotation.severity])}
          title={annotation.severity}
        />
        <span className="text-[10px] text-muted-foreground capitalize">
          {annotation.severity}
        </span>
        <div className="flex-1" />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(annotation.id);
          }}
          className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
          title="Delete annotation"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {annotation.type === "region" && annotation.geometry.type === "rect" && (
        <div className="text-[11px] text-muted-foreground font-mono">
          rect(
          {Math.round(annotation.geometry.x)}, {Math.round(annotation.geometry.y)},{" "}
          {Math.round(annotation.geometry.width)}, {Math.round(annotation.geometry.height)})
        </div>
      )}

      {annotation.type === "element" && annotation.geometry.type === "element" && (
        <AnnotationElementDetails geometry={annotation.geometry} />
      )}

      {isEditing ? (
        <div className="space-y-2">
          <Textarea
            value={draftDescription}
            onChange={(e) => setDraftDescription(e.target.value)}
            placeholder="Add a description..."
            className="min-h-[60px] text-xs"
          />
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => {
              setDraftDescription(annotation.description);
              setIsEditing(false);
            }}>
              Cancel
            </Button>
            <Button size="sm" className="h-7 text-xs" onClick={handleSave}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setDraftDescription(annotation.description);
            setIsEditing(true);
          }}
          className="text-xs text-foreground cursor-text min-h-[1.5em] hover:bg-secondary/50 rounded px-1 -mx-1 transition-colors"
        >
          {annotation.description || (
            <span className="text-muted-foreground italic">Click to add description...</span>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Select
          value={annotation.intent}
          onValueChange={(v) => onUpdate(annotation.id, { intent: v as Intent })}
        >
          <SelectTrigger className="h-7 text-xs w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {intentOptions.map((opt) => (
              <SelectItem key={opt} value={opt} className="text-xs">
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={annotation.severity}
          onValueChange={(v) => onUpdate(annotation.id, { severity: v as Severity })}
        >
          <SelectTrigger className="h-7 text-xs w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {severityOptions.map((opt) => (
              <SelectItem key={opt} value={opt} className="text-xs">
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function AnnotationPanel({ browserTabId: _browserTabId, url }: AnnotationPanelProps): React.JSX.Element {
  const annotations = useAnnotationStore((state) => state.getAnnotationsForUrl(url));
  const removeAnnotation = useAnnotationStore((state) => state.removeAnnotation);
  const updateAnnotation = useAnnotationStore((state) => state.updateAnnotation);
  const setSelectedAnnotationId = useAnnotationStore((state) => state.setSelectedAnnotationId);
  const selectedAnnotationId = useAnnotationStore(
    (state) => state.selectedAnnotationIdByUrl.get(normalizeUrl(url)) ?? null
  );

  const normalizedUrl = normalizeUrl(url);

  return (
    <div className="w-72 border-l border-border bg-background flex flex-col shrink-0">
      <div className="px-3 py-2 border-b border-border bg-card">
        <h3 className="text-sm font-medium">Annotations</h3>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          Session-scoped: annotations last until app close
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {annotations.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">
            No annotations on this page.
          </div>
        ) : (
          annotations.map((annotation) => (
            <AnnotationItem
              key={annotation.id}
              annotation={annotation}
              isSelected={selectedAnnotationId === annotation.id}
              onSelect={() => setSelectedAnnotationId(normalizedUrl, annotation.id)}
              onUpdate={(id, updates) => {
                updateAnnotation(normalizedUrl, id, updates);
              }}
              onDelete={(id) => {
                removeAnnotation(normalizedUrl, id);
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}
