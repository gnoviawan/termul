/**
 * AI prompt template types and built-in templates.
 *
 * Provides copy-paste ready prompt generation for AI CLI tools
 * (Cursor, Aider, Claude Code) with extensible template support.
 */

export interface AiPromptTemplate {
  id: string
  name: string
  description: string
  /** Tool name for display label */
  toolName: string
  /** Template string with {{variable}} placeholders */
  template: string
  /** Available template variables */
  variables: string[]
  /** Whether this is a built-in or user-created template */
  isBuiltIn: boolean
}

/** Template variable names */
export type TemplateVariable =
  | 'sourceBranch'
  | 'targetBranch'
  | 'conflictFiles'
  | 'worktreePath'
  | 'projectName'
  | 'diffContent'

/** Built-in templates for popular AI tools */
export const BUILT_IN_TEMPLATES: AiPromptTemplate[] = [
  {
    id: 'cursor-default',
    name: 'Cursor Default',
    description: 'Standard prompt for Cursor AI editor',
    toolName: 'Cursor',
    template: `I'm working on the {{sourceBranch}} branch in {{projectName}}. The active worktree is at {{worktreePath}}.

{{#if conflictFiles}}
There are merge conflicts in these files:
{{conflictFiles}}

Please help me resolve these conflicts, preserving the intent of both branches.
{{/if}}

Please review the current changes and suggest improvements.`,
    variables: ['sourceBranch', 'projectName', 'worktreePath', 'conflictFiles'],
    isBuiltIn: true
  },
  {
    id: 'aider-default',
    name: 'Aider Default',
    description: 'Standard prompt for Aider AI coding assistant',
    toolName: 'Aider',
    template: `I'm working on branch {{sourceBranch}} in project {{projectName}}.
Worktree path: {{worktreePath}}

{{#if conflictFiles}}
Help me resolve the following merge conflicts:
{{conflictFiles}}
{{/if}}

Focus on clean, maintainable code changes.`,
    variables: ['sourceBranch', 'projectName', 'worktreePath', 'conflictFiles'],
    isBuiltIn: true
  },
  {
    id: 'claude-code-default',
    name: 'Claude Code Default',
    description: 'Standard prompt for Claude Code CLI',
    toolName: 'Claude Code',
    template: `Context: Working on {{sourceBranch}} branch in {{projectName}} (worktree: {{worktreePath}})

{{#if conflictFiles}}
Merge conflicts detected in:
{{conflictFiles}}

Resolve each conflict by preserving the intent of both the {{sourceBranch}} and {{targetBranch}} branches.
{{/if}}

Analyze the current codebase state and provide actionable recommendations.`,
    variables: ['sourceBranch', 'targetBranch', 'projectName', 'worktreePath', 'conflictFiles'],
    isBuiltIn: true
  }
]

/**
 * Interpolate template variables into a prompt string.
 * Uses simple {{variable}} syntax with conditional {{#if variable}} blocks.
 */
export function interpolateTemplate(template: string, variables: Record<string, string>): string {
  let result = template

  // Handle {{#if variable}} ... {{/if}} conditionals
  result = result.replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, varName, content) => {
    return variables[varName] ? content : ''
  })

  // Handle {{variable}} replacements
  result = result.replace(/\{\{(\w+)\}\}/g, (_, varName) => {
    return variables[varName] ?? `{{${varName}}}`
  })

  // Clean up empty lines from removed conditionals
  result = result.replace(/\n{3,}/g, '\n\n').trim()

  return result
}

/**
 * Validate a template string for correct syntax.
 */
export function validateTemplate(template: string): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  // Check for unclosed {{#if}} blocks
  const ifOpen = (template.match(/\{\{#if \w+\}\}/g) ?? []).length
  const ifClose = (template.match(/\{\{\/if\}\}/g) ?? []).length
  if (ifOpen !== ifClose) {
    errors.push("Unclosed conditional blocks: {{#if}} count doesn't match {{/if}} count")
  }

  // Check for valid variable references and reject unknown placeholder names
  const allVars = template.match(/\{\{(\w+)\}\}/g) ?? []
  const knownVariables: string[] = [
    'sourceBranch',
    'targetBranch',
    'conflictFiles',
    'worktreePath',
    'projectName',
    'diffContent'
  ]

  for (const v of allVars) {
    // Skip Handlebars control tokens
    if (v.startsWith('{{#if') || v.startsWith('{{/if')) continue

    const name = v.slice(2, -2)
    if (!/^[a-zA-Z_]\w*$/.test(name)) {
      errors.push(`Invalid variable name: ${v}`)
      continue
    }

    // Reject unknown placeholder names
    if (!knownVariables.includes(name)) {
      errors.push(`Unknown template variable: ${v}`)
    }
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * Build template variables from worktree context.
 */
export function buildTemplateVariables(context: {
  sourceBranch: string
  targetBranch?: string
  conflictFiles?: string[]
  worktreePath: string
  projectName: string
  diffContent?: string
}): Record<string, string> {
  return {
    sourceBranch: context.sourceBranch,
    targetBranch: context.targetBranch ?? 'main',
    conflictFiles: context.conflictFiles?.join('\n') ?? '',
    worktreePath: context.worktreePath,
    projectName: context.projectName,
    diffContent: context.diffContent ?? ''
  }
}
