/**
 * AI Prompt Types
 *
 * Type definitions for AI prompt generation and template management.
 * Source: Story 3.1 - AI Prompt Generator Service
 */

/**
 * Supported AI tool types
 * - cursor: Cursor AI editor
 * - aider: Aider AI coding assistant
 * - claude-code: Claude Code CLI
 * - custom: User-defined custom template
 */
export type AIToolType = 'cursor' | 'aider' | 'claude-code' | 'custom'

/**
 * Context for prompt generation
 */
export interface PromptContext {
  worktreeId: string
  conflictedFiles?: string[]
  branchName: string
  targetBranch?: string
  projectPath: string
  additionalContext?: string
}

/**
 * Generated prompt result
 */
export interface GeneratedPrompt {
  tool: AIToolType
  prompt: string
  label: string
  copyToClipboard: boolean
  variables: Record<string, string>
  warning?: string
}

/**
 * Template variable definition
 */
export interface TemplateVariable {
  name: string
  description: string
  required: boolean
  defaultValue?: string
}

/**
 * AI tool template
 */
export interface AIToolTemplate {
  id: string
  name: string
  description: string
  tool: AIToolType
  promptTemplate: string
  variables: TemplateVariable[]
  requiredVars: string[]
  isDefault?: boolean
}

/**
 * Validation result for templates
 */
export interface ValidationResult {
  isValid: boolean
  errors: string[]
  warnings: string[]
}

// ============================================================================
// DTOs for IPC Communication
// ============================================================================

/**
 * DTO for generate prompt request
 */
export interface GeneratePromptDto {
  tool: AIToolType
  context: PromptContext
}

/**
 * DTO for template registration
 */
export interface RegisterTemplateDto {
  template: AIToolTemplate
}

/**
 * DTO for template validation
 */
export interface ValidateTemplateDto {
  template: AIToolTemplate
}

// ============================================================================
// Error Codes
// ============================================================================

/**
 * AI prompt error codes
 */
export const AIPromptErrorCode = {
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  INVALID_TEMPLATE: 'INVALID_TEMPLATE',
  MISSING_REQUIRED_VAR: 'MISSING_REQUIRED_VAR',
  TOOL_NOT_SUPPORTED: 'TOOL_NOT_SUPPORTED',
  GENERATION_FAILED: 'GENERATION_FAILED'
} as const

export type AIPromptErrorCodeType = (typeof AIPromptErrorCode)[keyof typeof AIPromptErrorCode]
