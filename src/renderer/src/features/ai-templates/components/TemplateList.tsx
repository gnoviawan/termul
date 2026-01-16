/**
 * Template List Component
 *
 * Renders list of AI tool templates with grid layout.
 * Source: Story 3.2 - Task 1.2: Create TemplateList component
 */

import { memo } from 'react'
import { AlertCircle } from 'lucide-react'
import { TemplateCard } from './TemplateCard'
import type { AIToolTemplate } from '@shared/types/ai-prompt.types'

export interface TemplateListProps {
  templates: AIToolTemplate[]
  selectedTemplate: AIToolTemplate | null
  onSelectTemplate: (template: AIToolTemplate) => void
  onEditTemplate: (template: AIToolTemplate) => void
  onDeleteTemplate: (templateId: string) => void
  onTestTemplate: (template: AIToolTemplate) => void
  isLoading?: boolean
  error?: string | null
}

/**
 * TemplateList - Displays templates in responsive grid
 *
 * Shows all available templates with filtering and empty states.
 */
export const TemplateList = memo(({
  templates,
  selectedTemplate,
  onSelectTemplate,
  onEditTemplate,
  onDeleteTemplate,
  onTestTemplate,
  isLoading = false,
  error = null
}: TemplateListProps) => {
  // Error state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
        <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
          <AlertCircle className="w-6 h-6 text-destructive" />
        </div>
        <h3 className="text-lg font-medium text-foreground mb-2">
          Failed to load templates
        </h3>
        <p className="text-sm text-muted-foreground max-w-md">
          {error}
        </p>
      </div>
    )
  }

  // Empty state
  if (templates.length === 0 && !isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
        <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center mb-4">
          <AlertCircle className="w-6 h-6 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-medium text-foreground mb-2">
          No templates found
        </h3>
        <p className="text-sm text-muted-foreground max-w-md">
          Create your first AI tool template to get started with prompt generation.
        </p>
      </div>
    )
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {templates.map((template) => (
        <TemplateCard
          key={template.id}
          template={template}
          isSelected={selectedTemplate?.id === template.id}
          onSelect={onSelectTemplate}
          onEdit={onEditTemplate}
          onDelete={onDeleteTemplate}
          onTest={onTestTemplate}
        />
      ))}
    </div>
  )
})

TemplateList.displayName = 'TemplateList'
