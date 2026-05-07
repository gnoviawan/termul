import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Copy, Check } from "lucide-react";
import { clipboardApi } from "@/lib/clipboard-api";
import type { Annotation, OutputLevel } from "@/stores/annotation-store";
import {
  exportAnnotationsToMarkdown,
  exportAnnotationsToJson,
  exportAnnotationsToAfsJson,
} from "@/lib/annotation-export";

interface AnnotationExportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  annotations: Annotation[];
}

export function AnnotationExportModal({
  open,
  onOpenChange,
  annotations,
}: AnnotationExportModalProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<"markdown" | "json" | "afs">("markdown");
  const [level, setLevel] = useState<OutputLevel>("standard");
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  const markdownPreview = exportAnnotationsToMarkdown(annotations, level);
  const jsonPreview = exportAnnotationsToJson(annotations);
  const afsPreview = exportAnnotationsToAfsJson(annotations);

  const handleCopy = async () => {
    const text = activeTab === "markdown" ? markdownPreview : activeTab === "json" ? jsonPreview : afsPreview;
    const result = await clipboardApi.writeText(text);
    if (result.success) {
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 2000);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl w-full">
        <DialogHeader>
          <DialogTitle>Export Annotations</DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "markdown" | "json" | "afs")}>
          <div className="flex items-center justify-between mb-3">
            <TabsList>
              <TabsTrigger value="markdown" className="text-xs">Markdown</TabsTrigger>
              <TabsTrigger value="json" className="text-xs">JSON</TabsTrigger>
              <TabsTrigger value="afs" className="text-xs">AFS (Agentation Format)</TabsTrigger>
            </TabsList>

            {activeTab === "markdown" && (
              <Select value={level} onValueChange={(v) => setLevel(v as OutputLevel)}>
                <SelectTrigger className="h-8 text-xs w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="compact" className="text-xs">Compact</SelectItem>
                  <SelectItem value="standard" className="text-xs">Standard</SelectItem>
                  <SelectItem value="detailed" className="text-xs">Detailed</SelectItem>
                </SelectContent>
              </Select>
            )}

            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={handleCopy}>
              {copyState === "copied" ? (
                <Check size={14} className="text-green-500" />
              ) : (
                <Copy size={14} />
              )}
              {copyState === "copied" ? "Copied" : "Copy"}
            </Button>
          </div>

          <TabsContent value="markdown">
            <pre className="rounded-lg bg-muted p-4 text-xs font-mono whitespace-pre-wrap overflow-auto max-h-[400px]">
              {markdownPreview}
            </pre>
          </TabsContent>

          <TabsContent value="json">
            <pre className="rounded-lg bg-muted p-4 text-xs font-mono whitespace-pre-wrap overflow-auto max-h-[400px]">
              {jsonPreview}
            </pre>
          </TabsContent>

          <TabsContent value="afs">
            <pre className="rounded-lg bg-muted p-4 text-xs font-mono whitespace-pre-wrap overflow-auto max-h-[400px]">
              {afsPreview}
            </pre>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
