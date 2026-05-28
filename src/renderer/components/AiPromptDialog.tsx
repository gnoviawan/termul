/**
 * AI Prompt Dialog — template picker with one-click copy.
 *
 * Provides a dialog that:
 * - Lists AI prompt templates (Cursor, Aider, Claude Code)
 * - Shows per-template variable filling for worktree context
 * - One-click copy button
 * - Per-tool labeling ("Paste this into [Tool]")
 */

import { useState, useCallback } from 'react'
import { Copy, Check, MessageSquare, Terminal, Bot } from 'lucide-react'
import {
  BUILT_IN_TEMPLATES,
  interpolateTemplate,
  buildTemplateVariables,
  type AiPromptTemplate,
} from '@/lib/ai-prompt-templates'
import { cn } from '@/lib/utils'

interface AiPromptDialogProps {
  isOpen: boolean
  onClose: () => void
  /** Worktree context for filling template variables */
  context?: {
    sourceBranch: string
    targetBranch?: string
    conflictFiles?: string[]
    worktreePath: string
    projectName: string
  }
}

const TOOL_ICONS: Record<string, typeof Bot> = {
  Cursor: MessageSquare,
  Aider: Terminal,
  'Claude Code': Bot,
}

export function AiPromptDialog({ isOpen, onClose, context }: AiPromptDialogProps) {
  const [selectedTemplate, setSelectedTemplate] = useState<AiPromptTemplate>(
    BUILT_IN_TEMPLATES[0]
  )
  const [copied, setCopied] = useState(false)

  const generatedPrompt = context
    ? interpolateTemplate(
        selectedTemplate.template,
        buildTemplateVariables({
          sourceBranch: context.sourceBranch,
          targetBranch: context.targetBranch,
          conflictFiles: context.conflictFiles,
          worktreePath: context.worktreePath,
          projectName: context.projectName,
        })
      )
    : ''

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(generatedPrompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = generatedPrompt
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }, [generatedPrompt])

  if (!isOpen) return null

  const Icon = TOOL_ICONS[selectedTemplate.toolName] ?? MessageSquare

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-prompt-dialog-title"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
    >
      <div className="w-[600px] max-w-[90vw] max-h-[80vh] bg-popover border border-border rounded-lg shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 id="ai-prompt-dialog-title" className="text-sm font-semibold text-foreground">AI Conflict Resolution Prompts</h2>
          <button
            onClick={onClose}
            className="h-6 w-6 flex items-center justify-center rounded hover:bg-secondary text-muted-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Template selector */}
        <div className="px-4 py-2 border-b border-border">
          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Tool</label>
          <div className="flex gap-2 mt-1">
            {BUILT_IN_TEMPLATES.map((tpl) => {
              const TplIcon = TOOL_ICONS[tpl.toolName] ?? MessageSquare
              return (
                <button
                  key={tpl.id}
                  onClick={() => setSelectedTemplate(tpl)}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors',
                    selectedTemplate.id === tpl.id
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-muted-foreground hover:text-foreground'
                  )}
                >
                  <TplIcon size={12} />
                  {tpl.toolName}
                </button>
              )
            })}
          </div>
        </div>

        {/* Prompt preview */}
        <div className="flex-1 overflow-auto px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              {selectedTemplate.name} — Paste this into {selectedTemplate.toolName}
            </span>
          </div>
          <pre className="whitespace-pre-wrap text-xs text-foreground bg-muted rounded-md p-3 font-mono leading-relaxed max-h-[300px] overflow-auto">
            {generatedPrompt || 'Select a worktree context to generate a prompt.'}
          </pre>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <span className="text-[10px] text-muted-foreground">
            Variables: {selectedTemplate.variables.join(', ')}
          </span>
          <button
            onClick={handleCopy}
            disabled={!generatedPrompt}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
              copied
                ? 'bg-green-500/10 text-green-500'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
              !generatedPrompt && 'opacity-50 cursor-not-allowed'
            )}
          >
            {copied ? (
              <><Check size={12} /> Copied!</>
            ) : (
              <><Copy size={12} /> Copy Prompt</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
