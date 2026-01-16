/**
 * AI Prompt Generator Service
 *
 * Core service for generating AI prompts with template system and variable interpolation.
 * Supports Cursor, Aider, Claude Code with extensible template management.
 *
 * Source: Story 3.1 - AI Prompt Generator Service
 */

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { app } from 'electron'
import type {
  AIToolType,
  PromptContext,
  GeneratedPrompt,
  AIToolTemplate,
  TemplateVariable,
  ValidationResult
} from '../../shared/types/ai-prompt.types'

/**
 * AI Prompt-specific error class
 */
export class AIPromptError extends Error {
  constructor(
    public code: string,
    message: string,
    public action?: string
  ) {
    super(message)
    this.name = 'AIPromptError'
  }
}

/**
 * AI Prompt Generator Service
 *
 * Manages prompt template generation for various AI coding tools.
 * Features variable interpolation, template validation, and persistence.
 *
 * @example
 * ```typescript
 * const generator = new AIPromptGenerator()
 * const prompt = await generator.generatePrompt('cursor', {
 *   worktreeId: 'wt-123',
 *   branchName: 'feature/auth',
 *   targetBranch: 'main',
 *   projectPath: '/path/to/project'
 * })
 * ```
 */
export class AIPromptGenerator {
  private templates: Map<string, AIToolTemplate>
  private readonly templatePath: string
  private readonly defaultTemplatesPath: string

  constructor() {
    this.templates = new Map()
    this.templatePath = path.join(app.getPath('userData'), 'ai-templates.json')
    this.defaultTemplatesPath = path.join(__dirname, '../../../resources/ai-templates')

    this.loadTemplates()
  }

  /**
   * Generate prompt for a specific AI tool
   *
   * Implements AC2, AC3, AC4: Generates prompts with conflict context,
   * variable interpolation, and tool-specific formatting.
   *
   * Task 2.2: Implement generatePrompt() method with tool-specific logic
   *
   * @param tool - AI tool type
   * @param context - Prompt context with variables
   * @returns Generated prompt with metadata
   */
  async generatePrompt(tool: AIToolType, context: PromptContext): Promise<GeneratedPrompt> {
    const template = this.getTemplateForTool(tool)

    // Validate required variables are provided
    const validation = this.validateTemplate(template)
    if (!validation.isValid) {
      throw new AIPromptError(
        'MISSING_REQUIRED_VAR',
        `Template validation failed: ${validation.errors.join(', ')}`
      )
    }

    // Check required vars are in context
    for (const varName of template.requiredVars) {
      if (!(varName in context) && !this.hasDefaultValue(template, varName)) {
        throw new AIPromptError(
          'MISSING_REQUIRED_VAR',
          `Required variable '${varName}' not provided in context`
        )
      }
    }

    // Interpolate template with context
    const prompt = this.interpolate(template.promptTemplate, context)

    // Add security warning for external AI services
    const warning = this.getSecurityWarning(tool)

    return {
      tool,
      prompt,
      label: `Paste this into ${this.getToolDisplayName(tool)}`,
      copyToClipboard: true,
      variables: this.extractVariables(context),
      warning
    }
  }

  /**
   * Register a custom template
   *
   * Task 2.5: Implement registerTemplate() method
   *
   * @param template - Template to register
   */
  registerTemplate(template: AIToolTemplate): void {
    // Validate template before registering
    const validation = this.validateTemplate(template)
    if (!validation.isValid) {
      throw new AIPromptError(
        'INVALID_TEMPLATE',
        `Cannot register invalid template: ${validation.errors.join(', ')}`
      )
    }

    this.templates.set(template.id, template)
  }

  /**
   * List all available templates
   *
   * Task 2.5: Implement listTemplates() method
   *
   * @returns Array of all templates
   */
  listTemplates(): AIToolTemplate[] {
    return Array.from(this.templates.values())
  }

  /**
   * Validate a template
   *
   * Implements AC7: Validates template syntax, required variables, tool type
   *
   * Task 2.4: Implement validateTemplate() method
   *
   * @param template - Template to validate
   * @returns Validation result with errors and warnings
   */
  validateTemplate(template: AIToolTemplate): ValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    // Check template syntax
    const variablePattern = /\{\{(\w+)\}\}/g
    const foundVars = new Set<string>()
    let match

    while ((match = variablePattern.exec(template.promptTemplate)) !== null) {
      foundVars.add(match[1])
    }

    // Validate required vars are defined in template variables
    for (const requiredVar of template.requiredVars) {
      if (!foundVars.has(requiredVar)) {
        errors.push(`Required variable '{{${requiredVar}}}' not found in template`)
      }
    }

    // Validate all variables in template are defined
    for (const varName of foundVars) {
      const varDef = template.variables.find(v => v.name === varName)
      if (!varDef) {
        warnings.push(`Variable '{{${varName}}}' used in template but not defined in variables list`)
      }
    }

    // Validate tool type
    const validTools: AIToolType[] = ['cursor', 'aider', 'claude-code', 'custom']
    if (!validTools.includes(template.tool)) {
      errors.push(`Invalid tool type: '${template.tool}'. Must be one of: ${validTools.join(', ')}`)
    }

    // Validate required fields
    if (!template.id || template.id.trim().length === 0) {
      errors.push('Template ID is required')
    }

    if (!template.name || template.name.trim().length === 0) {
      errors.push('Template name is required')
    }

    if (!template.promptTemplate || template.promptTemplate.trim().length === 0) {
      errors.push('Prompt template is required')
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    }
  }

  /**
   * Load templates from file system
   *
   * Task 6.1, 6.2: Implement persistence - load templates from file and resources
   */
  private async loadTemplates(): Promise<void> {
    try {
      // Load default templates from resources
      await this.loadDefaultTemplates()

      // Load custom templates from userData directory
      await this.loadCustomTemplates()
    } catch (error) {
      console.error('[AIPromptGenerator] Failed to load templates:', error)
    }
  }

  /**
   * Load default templates from resources directory
   */
  private async loadDefaultTemplates(): Promise<void> {
    const defaultTemplateFiles: Array<{ file: string; tool: AIToolType }> = [
      { file: 'cursor.json', tool: 'cursor' },
      { file: 'aider.json', tool: 'aider' },
      { file: 'claude-code.json', tool: 'claude-code' }
    ]

    for (const { file, tool } of defaultTemplateFiles) {
      try {
        const filePath = path.join(this.defaultTemplatesPath, file)
        const content = await fs.readFile(filePath, 'utf-8')
        const template: AIToolTemplate = JSON.parse(content)
        template.isDefault = true
        this.templates.set(template.id, template)
      } catch (error) {
        console.error(`[AIPromptGenerator] Failed to load default template ${file}:`, error)
      }
    }
  }

  /**
   * Load custom templates from userData directory
   */
  private async loadCustomTemplates(): Promise<void> {
    try {
      const content = await fs.readFile(this.templatePath, 'utf-8')
      const customTemplates: AIToolTemplate[] = JSON.parse(content)

      for (const template of customTemplates) {
        // Don't override default templates
        if (!template.isDefault) {
          this.templates.set(template.id, template)
        }
      }
    } catch (error) {
      // File doesn't exist yet - that's okay
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[AIPromptGenerator] Failed to load custom templates:', error)
      }
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Get template for a specific tool
   */
  private getTemplateForTool(tool: AIToolType): AIToolTemplate {
    // Find template for tool
    const template = Array.from(this.templates.values()).find(t => t.tool === tool)

    if (!template) {
      throw new AIPromptError(
        'TEMPLATE_NOT_FOUND',
        `No template found for tool: '${tool}'`
      )
    }

    return template
  }

  /**
   * Interpolate template variables with context values
   *
   * Task 2.3: Implement variable interpolation engine
   *
   * @param template - Template string with {{var}} placeholders
   * @param context - Variable values
   * @returns Interpolated string
   */
  private interpolate(template: string, context: PromptContext): string {
    const variablePattern = /\{\{(\w+)\}\}/g

    return template.replace(variablePattern, (match, varName) => {
      // Check context first
      if (varName in context) {
        const value = context[varName as keyof PromptContext]
        return value !== undefined ? String(value) : match
      }

      // Return match as-is if not found (will be validated earlier)
      return match
    })
  }

  /**
   * Extract variables from context for display
   */
  private extractVariables(context: PromptContext): Record<string, string> {
    const variables: Record<string, string> = {}

    for (const [key, value] of Object.entries(context)) {
      if (value !== undefined) {
        variables[key] = String(value)
      }
    }

    return variables
  }

  /**
   * Get display name for tool
   */
  private getToolDisplayName(tool: AIToolType): string {
    const displayNames: Record<AIToolType, string> = {
      cursor: 'Cursor',
      aider: 'Aider',
      'claude-code': 'Claude Code',
      custom: 'Custom Tool'
    }

    return displayNames[tool]
  }

  /**
   * Check if variable has default value in template
   */
  private hasDefaultValue(template: AIToolTemplate, varName: string): boolean {
    const varDef = template.variables.find(v => v.name === varName)
    return varDef?.defaultValue !== undefined
  }

  /**
   * Get security warning for external AI services
   *
   * Task 7.1, 7.3: Add warning about external AI services, local-only AI mode support
   */
  private getSecurityWarning(tool: AIToolType): string | undefined {
    // No warning for local-only mode (custom tool can be local)
    if (tool === 'custom') {
      return undefined
    }

    return `⚠️ External AI Service Warning

This prompt is intended for use with ${this.getToolDisplayName(tool)}, which is an external AI service.

By pasting this prompt, you will be sending your code to an external service.
Please ensure you have permission to share this code.

- For local-only AI mode, use a custom template
- Never send API keys, credentials, or sensitive data
- Review your code for secrets before sharing`
  }
}
