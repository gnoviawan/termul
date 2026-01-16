/**
 * Template Details Panel Component
 *
 * Displays full details of a selected template with syntax highlighting.
 * Read-only view for default templates, edit mode for custom templates.
 * Source: Story 3.2 - Task 3: Create Template Details Panel
 */

import { memo } from 'react'
import { Edit, Play, AlertTriangle, Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AIToolTemplate } from '@shared/types/ai-prompt.types'

export interface TemplateDetailsPanelProps {
  template: AIToolTemplate
  onEdit: (template: AIToolTemplate) => void
  onTest: (template: AIToolTemplate) => void
  canEdit: boolean
}

/**
 * Get tool display name
 */
function getToolDisplayName(tool: string): string {
  switch (tool) {
    case 'cursor':
      return 'Cursor'
    case 'aider':
      return 'Aider'
    case 'claude-code':
      return 'Claude Code'
    case 'custom':
      return 'Custom'
    default:
      return tool
  }
}

/**
 * Get tool color classes
 */
function getToolColorClasses(tool: string) {
  switch (tool) {
    case 'cursor':
      return 'bg-blue-500/10 text-blue-500 border-blue-500/20'
    case 'aider':
      return 'bg-green-500/10 text-green-500 border-green-500/20'
    case 'claude-code':
      return 'bg-purple-500/10 text-purple-500 border-purple-500/20'
    default:
      return 'bg-secondary/50 text-muted-foreground border-border'
  }
}

/**
 * Highlight template variables in text
 */
function highlightVariables(template: string): string {
  // This is a simple placeholder for syntax highlighting
  // In a production app, you'd use a proper syntax highlighter
  return template
}

/**
 * TemplateDetailsPanel - Read-only or editable template view
 *
 * Displays full prompt template with variable highlighting.
 * Shows variables table with descriptions.
 * Edit/Test buttons for custom templates.
 */
export const TemplateDetailsPanel = memo(({
  template,
  onEdit,
  onTest,
  canEdit
}: TemplateDetailsPanelProps) => {
  const requiredVars = template.variables.filter(v => v.required)
  const optionalVars = template.variables.filter(v => !v.required)

  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(template.promptTemplate)
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-semibold text-foreground">
              {template.name}
            </h1>
            {template.isDefault && (
              <span className="flex-shrink-0 text-xs px-2 py-1 bg-primary/10 text-primary rounded">
                Default Template
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {template.description}
          </p>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => onTest(template)}
            className="px-4 py-2 text-sm font-medium bg-primary/10 text-primary rounded hover:bg-primary/20 transition-colors flex items-center gap-2"
          >
            <Play className="w-4 h-4" />
            Test Template
          </button>

          {canEdit && (
            <button
              onClick={() => onEdit(template)}
              className="px-4 py-2 text-sm font-medium bg-secondary/50 text-foreground rounded hover:bg-secondary transition-colors flex items-center gap-2"
            >
              <Edit className="w-4 h-4" />
              Edit Template
            </button>
          )}
        </div>
      </div>

      {/* Warning for default templates */}
      {template.isDefault && (
        <div className="flex items-start gap-3 p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
          <AlertTriangle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="text-sm font-medium text-yellow-500">
              Default templates cannot be modified
            </h3>
            <p className="text-xs text-yellow-500/80 mt-1">
              Default templates are built into the application. Create a custom template if you need to modify this prompt.
            </p>
          </div>
        </div>
      )}

      {/* Template info */}
      <div className="flex items-center gap-4 text-sm">
        <div className={cn(
          'px-3 py-1.5 rounded border flex items-center gap-2',
          getToolColorClasses(template.tool)
        )}>
          <span className="font-medium">
            {getToolDisplayName(template.tool)}
          </span>
        </div>
        <div className="text-muted-foreground">
          {requiredVars.length} required variables, {optionalVars.length} optional
        </div>
      </div>

      {/* Prompt template */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-medium text-foreground">
            Prompt Template
          </h2>
          <button
            onClick={handleCopyPrompt}
            className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Copy className="w-3 h-3" />
            Copy to clipboard
          </button>
        </div>

        <div className="bg-secondary/30 rounded-lg border border-border p-4 font-mono text-sm leading-relaxed whitespace-pre-wrap text-foreground max-h-[400px] overflow-y-auto">
          {template.promptTemplate}
        </div>
      </div>

      {/* Variables table */}
      {template.variables.length > 0 && (
        <div>
          <h2 className="text-lg font-medium text-foreground mb-3">
            Template Variables
          </h2>

          <div className="bg-card rounded-lg border border-border overflow-hidden">
            <table className="w-full">
              <thead className="bg-secondary/50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Variable
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Description
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-4 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Default
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {template.variables.map((variable, index) => (
                  <tr key={index} className="hover:bg-secondary/30">
                    <td className="px-4 py-3">
                      <code className="text-sm font-mono text-primary">
                        {'{{'}
                        {variable.name}
                        {'}}'}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">
                      {variable.description}
                    </td>
                    <td className="px-4 py-3">
                      {variable.required ? (
                        <span className="text-xs px-2 py-1 bg-destructive/10 text-destructive rounded">
                          Required
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-1 bg-secondary/50 text-muted-foreground rounded">
                          Optional
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-muted-foreground">
                      {variable.defaultValue || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
})

TemplateDetailsPanel.displayName = 'TemplateDetailsPanel'
