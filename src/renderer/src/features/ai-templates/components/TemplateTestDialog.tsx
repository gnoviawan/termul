/**
 * Template Test Dialog Component
 *
 * Dialog for testing templates with sample context data.
 * Pre-populated form with sample values for testing prompt generation.
 * Source: Story 3.2 - Task 4: Create Template Test Dialog
 */

import { useState, useCallback, useEffect, memo } from 'react'
import { X, Play, Copy, Check, Loader2, AlertCircle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { AIToolTemplate, PromptContext } from '@shared/types/ai-prompt.types'

export interface TemplateTestDialogProps {
  isOpen: boolean
  template: AIToolTemplate
  onClose: () => void
}

/**
 * Default sample context for testing
 */
const DEFAULT_SAMPLE_CONTEXT: PromptContext = {
  worktreeId: 'wt-example',
  branchName: 'feature/example',
  targetBranch: 'main',
  projectPath: '/path/to/project',
  conflictedFiles: ['src/example.ts', 'src/test.ts']
}

/**
 * TemplateTestDialog - Test template with sample data
 *
 * Pre-populated form with sample context data.
 * Generate prompt and preview with highlighted variables.
 */
export function TemplateTestDialog({ isOpen, template, onClose }: TemplateTestDialogProps) {
  const [context, setContext] = useState<PromptContext>(DEFAULT_SAMPLE_CONTEXT)
  const [generatedPrompt, setGeneratedPrompt] = useState<string>('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (isOpen) {
      setContext(DEFAULT_SAMPLE_CONTEXT)
      setGeneratedPrompt('')
      setError(null)
      setCopied(false)
    }
  }, [isOpen, template])

  // Handle generate prompt
  const handleGenerate = useCallback(async () => {
    setIsGenerating(true)
    setError(null)

    try {
      const result = await window.api.aiPrompt.generate({
        tool: template.tool,
        context
      })

      if (result.success && result.data) {
        setGeneratedPrompt(result.data.prompt)
      } else {
        setError('error' in result ? result.error : 'Failed to generate prompt')
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setIsGenerating(false)
    }
  }, [template, context])

  // Handle copy to clipboard
  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(generatedPrompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [generatedPrompt])

  if (!isOpen) return null

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.15 }}
            className="bg-card rounded-lg shadow-2xl w-full max-w-3xl border border-border overflow-hidden flex flex-col max-h-[90vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  Test Template: {template.name}
                </h2>
                <p className="text-xs text-muted-foreground mt-1">
                  Test the template with sample context data
                </p>
              </div>
              <button
                onClick={onClose}
                className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              <div className="p-6 space-y-6">
                {/* Sample context form */}
                <div>
                  <h3 className="text-sm font-medium text-foreground mb-3">
                    Sample Context Data
                  </h3>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Worktree ID */}
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                        Worktree ID
                      </label>
                      <input
                        type="text"
                        value={context.worktreeId}
                        onChange={(e) => setContext({ ...context, worktreeId: e.target.value })}
                        className="w-full bg-secondary/50 border border-border rounded px-3 py-2 text-sm font-mono text-foreground focus:ring-2 focus:ring-primary outline-none"
                      />
                    </div>

                    {/* Branch Name */}
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                        Branch Name
                      </label>
                      <input
                        type="text"
                        value={context.branchName}
                        onChange={(e) => setContext({ ...context, branchName: e.target.value })}
                        className="w-full bg-secondary/50 border border-border rounded px-3 py-2 text-sm font-mono text-foreground focus:ring-2 focus:ring-primary outline-none"
                      />
                    </div>

                    {/* Target Branch */}
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                        Target Branch
                      </label>
                      <input
                        type="text"
                        value={context.targetBranch || ''}
                        onChange={(e) => setContext({ ...context, targetBranch: e.target.value })}
                        className="w-full bg-secondary/50 border border-border rounded px-3 py-2 text-sm font-mono text-foreground focus:ring-2 focus:ring-primary outline-none"
                      />
                    </div>

                    {/* Project Path */}
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                        Project Path
                      </label>
                      <input
                        type="text"
                        value={context.projectPath}
                        onChange={(e) => setContext({ ...context, projectPath: e.target.value })}
                        className="w-full bg-secondary/50 border border-border rounded px-3 py-2 text-sm font-mono text-foreground focus:ring-2 focus:ring-primary outline-none"
                      />
                    </div>

                    {/* Conflicted Files */}
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                        Conflicted Files (comma-separated)
                      </label>
                      <input
                        type="text"
                        value={context.conflictedFiles?.join(', ') || ''}
                        onChange={(e) => setContext({
                          ...context,
                          conflictedFiles: e.target.value.split(',').map(f => f.trim()).filter(Boolean)
                        })}
                        className="w-full bg-secondary/50 border border-border rounded px-3 py-2 text-sm font-mono text-foreground focus:ring-2 focus:ring-primary outline-none"
                      />
                    </div>
                  </div>
                </div>

                {/* Error display */}
                {error && (
                  <div className="flex items-start gap-3 p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
                    <AlertCircle className="w-5 h-5 text-destructive flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <h3 className="text-sm font-medium text-destructive">
                        Generation Failed
                      </h3>
                      <p className="text-xs text-destructive/80 mt-1">
                        {error}
                      </p>
                    </div>
                  </div>
                )}

                {/* Generated prompt preview */}
                {generatedPrompt && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-medium text-foreground">
                        Generated Prompt
                      </h3>
                      <button
                        onClick={handleCopy}
                        className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {copied ? (
                          <>
                            <Check className="w-3 h-3 text-green-500" />
                            Copied!
                          </>
                        ) : (
                          <>
                            <Copy className="w-3 h-3" />
                            Copy to clipboard
                          </>
                        )}
                      </button>
                    </div>

                    <div className="bg-secondary/30 rounded-lg border border-border p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap text-foreground max-h-[400px] overflow-y-auto">
                      {generatedPrompt}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-secondary/20 flex-shrink-0">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
              >
                Close
              </button>

              <button
                onClick={handleGenerate}
                disabled={isGenerating}
                className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Play className="w-4 h-4" />
                    Generate Prompt
                  </>
                )}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
