/**
 * Template Card Component
 *
 * Displays a single AI tool template card with name, description,
 * tool icon, variable count, and action buttons.
 * Source: Story 3.2 - Task 1.3: Create TemplateCard component
 */

import { memo } from 'react'
import { Edit, Trash2, Bot, Eye, Zap } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import type { AIToolTemplate } from '@shared/types/ai-prompt.types'

export interface TemplateCardProps {
  template: AIToolTemplate
  onSelect: (template: AIToolTemplate) => void
  onEdit: (template: AIToolTemplate) => void
  onDelete: (templateId: string) => void
  onTest: (template: AIToolTemplate) => void
  isSelected: boolean
}

/**
 * Get tool icon for AI tool type
 */
function getToolIcon(tool: string) {
  switch (tool) {
    case 'cursor':
      return <Bot className="w-5 h-5" />
    case 'aider':
      return <Zap className="w-5 h-5" />
    case 'claude-code':
      return <Eye className="w-5 h-5" />
    default:
      return <Bot className="w-5 h-5" />
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
 * TemplateCard - Displays single template with hover preview
 *
 * Shows template name, description, tool icon, variable count.
 * Edit and delete buttons for custom templates only.
 */
export const TemplateCard = memo(({
  template,
  onSelect,
  onEdit,
  onDelete,
  onTest,
  isSelected
}: TemplateCardProps) => {
  const requiredCount = template.variables.filter(v => v.required).length
  const optionalCount = template.variables.filter(v => !v.required).length
  const canEdit = !template.isDefault

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -2 }}
      transition={{ duration: 0.15 }}
      onClick={() => onSelect(template)}
      className={cn(
        'relative bg-card border rounded-lg p-4 cursor-pointer transition-all',
        'hover:border-primary/50 hover:shadow-md',
        isSelected && 'border-primary ring-1 ring-primary/50'
      )}
    >
      {/* Header with tool icon and name */}
      <div className="flex items-start gap-3 mb-3">
        <div className={cn(
          'flex-shrink-0 w-10 h-10 rounded-lg border flex items-center justify-center',
          getToolColorClasses(template.tool)
        )}>
          {getToolIcon(template.tool)}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-foreground truncate">
              {template.name}
            </h3>
            {template.isDefault && (
              <span className="flex-shrink-0 text-xs px-1.5 py-0.5 bg-primary/10 text-primary rounded">
                Default
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2 mt-1">
            {template.description}
          </p>
        </div>
      </div>

      {/* Variable count */}
      <div className="flex items-center gap-4 text-xs text-muted-foreground mb-3">
        <span>{requiredCount} required</span>
        <span>{optionalCount} optional</span>
      </div>

      {/* Prompt preview (first 100 chars) */}
      {template.promptTemplate && (
        <div className="text-xs font-mono text-muted-foreground bg-secondary/30 rounded p-2 line-clamp-2 mb-3">
          {template.promptTemplate.slice(0, 100)}
          {template.promptTemplate.length > 100 && '...'}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => onTest(template)}
          className="flex-1 px-3 py-1.5 text-xs font-medium bg-primary/10 text-primary rounded hover:bg-primary/20 transition-colors"
        >
          Test
        </button>

        {canEdit && (
          <>
            <button
              onClick={() => onEdit(template)}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-secondary rounded transition-colors"
              aria-label="Edit template"
            >
              <Edit className="w-4 h-4" />
            </button>

            <button
              onClick={() => onDelete(template.id)}
              className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors"
              aria-label="Delete template"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </>
        )}
      </div>
    </motion.div>
  )
})

TemplateCard.displayName = 'TemplateCard'
