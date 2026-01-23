/**
 * Code review prompt engineering for GLM 4.7 model
 * Provides structured prompts for automated code review
 */

/**
 * Severity levels for code review
 */
export type ReviewSeverity = 'low' | 'medium' | 'high' | 'critical'

/**
 * Code change context for review
 */
export interface CodeChangeContext {
  filePath: string
  diff: string
  language?: string
  lineStart?: number
  lineEnd?: number
}

/**
 * Review options to customize the prompt
 */
export interface ReviewOptions {
  severity: ReviewSeverity
  focusAreas?: string[]
  maxSuggestions?: number
  includeSecurity?: boolean
  includePerformance?: boolean
  includeBestPractices?: boolean
}

/**
 * Default review options
 */
const DEFAULT_REVIEW_OPTIONS: ReviewOptions = {
  severity: 'medium',
  maxSuggestions: 10,
  includeSecurity: true,
  includePerformance: true,
  includeBestPractices: true
}

/**
 * Generate a comprehensive code review prompt for GLM 4.7
 *
 * @param changes - Array of code changes to review
 * @param options - Review options to customize the analysis
 * @returns Formatted prompt string for GLM 4.7
 */
export function generateReviewPrompt(
  changes: CodeChangeContext[],
  options: ReviewOptions = DEFAULT_REVIEW_OPTIONS
): string {
  const opts = { ...DEFAULT_REVIEW_OPTIONS, ...options }

  let prompt = buildSystemPrompt(opts)
  prompt += '\n\n'
  prompt += buildChangesSection(changes)
  prompt += '\n\n'
  prompt += buildReviewInstructions(opts)

  return prompt
}

/**
 * Generate a system prompt that defines the AI's role and behavior
 */
function buildSystemPrompt(options: ReviewOptions): string {
  const severityGuidance = getSeverityGuidance(options.severity)

  return `You are an expert code reviewer conducting a thorough automated code review. Your role is to:
- Analyze the provided code changes for potential issues
- Provide actionable, specific feedback
- Focus on ${severityGuidance}
- Be constructive and educational in your feedback

Your review should be concise, specific, and prioritized by importance.`
}

/**
 * Build the section containing the actual code changes
 */
function buildChangesSection(changes: CodeChangeContext[]): string {
  if (changes.length === 0) {
    return 'No code changes to review.'
  }

  let section = '## Code Changes to Review\n\n'

  changes.forEach((change, index) => {
    section += `### File ${index + 1}: ${change.filePath}\n\n`

    if (change.language) {
      section += `**Language:** ${change.language}\n\n`
    }

    if (change.lineStart !== undefined && change.lineEnd !== undefined) {
      section += `**Lines:** ${change.lineStart}-${change.lineEnd}\n\n`
    }

    section += '```diff\n'
    section += change.diff
    section += '\n```\n\n'
  })

  return section
}

/**
 * Build specific review instructions based on options
 */
function buildReviewInstructions(options: ReviewOptions): string {
  let instructions = '## Review Instructions\n\n'
  instructions += 'Please review the code changes and provide feedback in the following format:\n\n'
  instructions += '### Review Summary\n'
  instructions += 'A brief overview of the changes and their quality.\n\n'
  instructions += '### Issues Found\n'
  instructions += 'List each issue with:\n'
  instructions += '- **Severity:** [critical/high/medium/low]\n'
  instructions += '- **Location:** File and line number\n'
  instructions += '- **Issue:** Clear description of the problem\n'
  instructions += '- **Suggestion:** Specific fix or improvement\n'
  instructions += '- **Reason:** Why this matters\n\n'

  if (options.includeSecurity) {
    instructions += '### Security Considerations\n'
    instructions += 'Highlight any potential security vulnerabilities, including:\n'
    instructions += '- Injection vulnerabilities (SQL, XSS, command injection)\n'
    instructions += '- Authentication and authorization issues\n'
    instructions += '- Sensitive data exposure\n'
    instructions += '- Cryptographic issues\n\n'
  }

  if (options.includePerformance) {
    instructions += '### Performance Considerations\n'
    instructions += 'Identify performance issues such as:\n'
    instructions += '- Inefficient algorithms or data structures\n'
    instructions += '- Unnecessary database queries or API calls\n'
    instructions += '- Memory leaks or excessive resource usage\n'
    instructions += '- Caching opportunities\n\n'
  }

  if (options.includeBestPractices) {
    instructions += '### Best Practices\n'
    instructions += 'Check for adherence to:\n'
    instructions += '- Language-specific conventions and idioms\n'
    instructions += '- SOLID principles and design patterns\n'
    instructions += '- Code readability and maintainability\n'
    instructions += '- Error handling and edge cases\n'
    instructions += '- Testing considerations\n\n'
  }

  if (options.focusAreas && options.focusAreas.length > 0) {
    instructions += '### Focus Areas\n'
    instructions += `Pay special attention to: ${options.focusAreas.join(', ')}\n\n`
  }

  instructions += `### Severity Level\n`
  instructions += `Filter issues based on severity: **${options.severity}** and above\n\n`

  instructions += '### Positive Feedback\n'
  instructions += 'Also highlight what was done well in these changes.\n\n'

  if (options.maxSuggestions) {
    instructions += `**Note:** Provide at most ${options.maxSuggestions} issues, prioritized by severity and impact.\n`
  }

  return instructions
}

/**
 * Get severity-specific guidance for the review
 */
function getSeverityGuidance(severity: ReviewSeverity): string {
  switch (severity) {
    case 'critical':
      return 'CRITICAL issues only - security vulnerabilities, data loss risks, severe bugs'
    case 'high':
      return 'HIGH and CRITICAL issues - serious bugs, security issues, major performance problems'
    case 'medium':
      return 'MEDIUM severity and above - bugs, security issues, performance problems, and code quality concerns'
    case 'low':
      return 'ALL issues - including minor style improvements, suggestions, and optimizations'
    default:
      return 'MEDIUM severity and above - bugs, security issues, performance problems, and code quality concerns'
  }
}

/**
 * Generate a prompt for reviewing a single file
 *
 * @param filePath - Path to the file being reviewed
 * @param diff - Git diff of the changes
 * @param language - Programming language (optional)
 * @returns Formatted prompt for single-file review
 */
export function generateSingleFileReviewPrompt(
  filePath: string,
  diff: string,
  language?: string
): string {
  return generateReviewPrompt(
    [
      {
        filePath,
        diff,
        language
      }
    ],
    DEFAULT_REVIEW_OPTIONS
  )
}

/**
 * Generate a focused security review prompt
 *
 * @param changes - Array of code changes to review
 * @returns Security-focused review prompt
 */
export function generateSecurityReviewPrompt(changes: CodeChangeContext[]): string {
  return generateReviewPrompt(changes, {
    severity: 'high',
    includeSecurity: true,
    includePerformance: false,
    includeBestPractices: false,
    focusAreas: ['security vulnerabilities', 'authentication', 'authorization', 'data protection']
  })
}

/**
 * Generate a lightweight review prompt for quick feedback
 *
 * @param changes - Array of code changes to review
 * @returns Concise review prompt
 */
export function generateQuickReviewPrompt(changes: CodeChangeContext[]): string {
  return generateReviewPrompt(changes, {
    severity: 'high',
    maxSuggestions: 5,
    includeSecurity: true,
    includePerformance: false,
    includeBestPractices: false
  })
}
