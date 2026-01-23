/**
 * Comment formatter for code review feedback
 * Formats review results from GLM 4.7 into Markdown for PR comments
 */

/**
 * Severity levels for review issues
 */
export type ReviewIssueSeverity = 'critical' | 'high' | 'medium' | 'low'

/**
 * Individual review issue
 */
export interface ReviewIssue {
  severity: ReviewIssueSeverity
  file: string
  line?: number
  issue: string
  suggestion: string
  reason?: string
}

/**
 * Review feedback from GLM 4.7
 */
export interface ReviewFeedback {
  summary: string
  issues: ReviewIssue[]
  security?: string[]
  performance?: string[]
  bestPractices?: string[]
  positiveFeedback?: string[]
}

/**
 * Options for formatting comments
 */
export interface FormatCommentOptions {
  includeSummary?: boolean
  includePositiveFeedback?: boolean
  maxIssuesPerSeverity?: number
  groupBySeverity?: boolean
  includeLineNumbers?: boolean
}

/**
 * Default formatting options
 */
const DEFAULT_FORMAT_OPTIONS: FormatCommentOptions = {
  includeSummary: true,
  includePositiveFeedback: true,
  maxIssuesPerSeverity: 10,
  groupBySeverity: true,
  includeLineNumbers: true
}

/**
 * Format review feedback as a Markdown comment for PR
 *
 * @param feedback - Review feedback from GLM 4.7
 * @param options - Formatting options
 * @returns Formatted Markdown string ready for PR comment
 */
export function formatComment(
  feedback: ReviewFeedback,
  options: FormatCommentOptions = {}
): string {
  const opts = { ...DEFAULT_FORMAT_OPTIONS, ...options }

  let markdown = ''

  // Add header
  markdown += buildHeader()

  // Add summary
  if (opts.includeSummary && feedback.summary) {
    markdown += buildSummarySection(feedback.summary)
  }

  // Add issues
  if (feedback.issues.length > 0) {
    if (opts.groupBySeverity) {
      markdown += buildGroupedIssuesSection(feedback.issues, opts)
    } else {
      markdown += buildFlatIssuesSection(feedback.issues, opts)
    }
  }

  // Add security considerations
  if (feedback.security && feedback.security.length > 0) {
    markdown += buildSecuritySection(feedback.security)
  }

  // Add performance considerations
  if (feedback.performance && feedback.performance.length > 0) {
    markdown += buildPerformanceSection(feedback.performance)
  }

  // Add best practices
  if (feedback.bestPractices && feedback.bestPractices.length > 0) {
    markdown += buildBestPracticesSection(feedback.bestPractices)
  }

  // Add positive feedback
  if (opts.includePositiveFeedback && feedback.positiveFeedback && feedback.positiveFeedback.length > 0) {
    markdown += buildPositiveFeedbackSection(feedback.positiveFeedback)
  }

  // Add footer
  markdown += buildFooter()

  return markdown
}

/**
 * Format a single line comment for a specific file and line
 *
 * @param issue - Review issue to format
 * @returns Formatted single-line comment
 */
export function formatLineComment(issue: ReviewIssue): string {
  const emoji = getSeverityEmoji(issue.severity)
  return `${emoji} **${issue.severity.toUpperCase()}**: ${issue.issue}\n\n**Suggestion:** ${issue.suggestion}`
}

/**
 * Format a summary comment when no issues are found
 *
 * @param summary - Review summary
 * @param positiveFeedback - Optional positive feedback
 * @returns Formatted "no issues" comment
 */
export function formatNoIssuesComment(
  summary: string,
  positiveFeedback?: string[]
): string {
  let markdown = buildHeader()
  markdown += '## ✅ Review Results\n\n'
  markdown += '**No issues found!** The code changes look good.\n\n'

  if (summary) {
    markdown += `### Summary\n\n${summary}\n\n`
  }

  if (positiveFeedback && positiveFeedback.length > 0) {
    markdown += '### What Was Done Well\n\n'
    positiveFeedback.forEach((feedback) => {
      markdown += `- ✨ ${feedback}\n`
    })
    markdown += '\n'
  }

  markdown += buildFooter()
  return markdown
}

/**
 * Build the comment header with bot signature
 */
function buildHeader(): string {
  return '<!-- code-reviewer-comment -->\n\n# 🤖 Code Review Report\n\n'
}

/**
 * Build the summary section
 */
function buildSummarySection(summary: string): string {
  return `## 📝 Summary\n\n${summary}\n\n`
}

/**
 * Build issues section grouped by severity
 */
function buildGroupedIssuesSection(
  issues: ReviewIssue[],
  options: FormatCommentOptions
): string {
  let markdown = '## 🔍 Issues Found\n\n'

  // Group by severity
  const grouped = groupIssuesBySeverity(issues)

  // Order: critical, high, medium, low
  const severityOrder: ReviewIssueSeverity[] = ['critical', 'high', 'medium', 'low']

  for (const severity of severityOrder) {
    const severityIssues = grouped[severity]
    if (!severityIssues || severityIssues.length === 0) {
      continue
    }

    const emoji = getSeverityEmoji(severity)
    const count = severityIssues.length
    markdown += `### ${emoji} ${severity.toUpperCase()} (${count})\n\n`

    // Limit issues per severity
    const maxIssues: number = options.maxIssuesPerSeverity ?? DEFAULT_FORMAT_OPTIONS.maxIssuesPerSeverity!
    const limitedIssues = severityIssues.slice(0, maxIssues)

    limitedIssues.forEach((issue, index) => {
      markdown += formatIssue(issue, index + 1, options)
    })

    if (severityIssues.length > maxIssues) {
      markdown += `\n_*${severityIssues.length - maxIssues} more ${severity} issues hidden_*\n\n`
    }

    markdown += '\n'
  }

  return markdown
}

/**
 * Build issues section as a flat list
 */
function buildFlatIssuesSection(
  issues: ReviewIssue[],
  options: FormatCommentOptions
): string {
  let markdown = `## 🔍 Issues Found (${issues.length})\n\n`

  const maxIssues: number = options.maxIssuesPerSeverity ?? DEFAULT_FORMAT_OPTIONS.maxIssuesPerSeverity!
  issues.slice(0, maxIssues).forEach((issue, index) => {
    markdown += formatIssue(issue, index + 1, options)
  })

  if (issues.length > maxIssues) {
    markdown += `\n_*${issues.length - maxIssues} more issues hidden_*\n\n`
  }

  return markdown + '\n'
}

/**
 * Format a single issue
 */
function formatIssue(
  issue: ReviewIssue,
  index: number,
  options: FormatCommentOptions
): string {
  const emoji = getSeverityEmoji(issue.severity)
  let markdown = `#### ${index}. ${emoji} ${issue.issue}\n\n`

  // Location
  if (options.includeLineNumbers && issue.line !== undefined) {
    markdown += `**Location:** \`${issue.file}:${issue.line}\`\n\n`
  } else if (issue.file) {
    markdown += `**Location:** \`${issue.file}\`\n\n`
  }

  // Severity badge
  markdown += `**Severity:** ${getSeverityBadge(issue.severity)}\n\n`

  // Suggestion
  markdown += `**Suggestion:** ${issue.suggestion}\n\n`

  // Reason (optional)
  if (issue.reason) {
    markdown += `**Why:** ${issue.reason}\n\n`
  }

  return markdown
}

/**
 * Build security considerations section
 */
function buildSecuritySection(security: string[]): string {
  let markdown = '## 🔒 Security Considerations\n\n'

  security.forEach((item) => {
    markdown += `- ⚠️ ${item}\n`
  })

  return markdown + '\n'
}

/**
 * Build performance considerations section
 */
function buildPerformanceSection(performance: string[]): string {
  let markdown = '## ⚡ Performance Considerations\n\n'

  performance.forEach((item) => {
    markdown += `- 📊 ${item}\n`
  })

  return markdown + '\n'
}

/**
 * Build best practices section
 */
function buildBestPracticesSection(bestPractices: string[]): string {
  let markdown = '## 💡 Best Practices\n\n'

  bestPractices.forEach((item) => {
    markdown += `- ✨ ${item}\n`
  })

  return markdown + '\n'
}

/**
 * Build positive feedback section
 */
function buildPositiveFeedbackSection(positiveFeedback: string[]): string {
  let markdown = '## ✨ What Was Done Well\n\n'

  positiveFeedback.forEach((feedback) => {
    markdown += `- 🎉 ${feedback}\n`
  })

  return markdown + '\n'
}

/**
 * Build comment footer
 */
function buildFooter(): string {
  return '<!-- /code-reviewer-comment -->\n'
}

/**
 * Group issues by severity
 */
function groupIssuesBySeverity(issues: ReviewIssue[]): Record<ReviewIssueSeverity, ReviewIssue[]> {
  const grouped: Record<ReviewIssueSeverity, ReviewIssue[]> = {
    critical: [],
    high: [],
    medium: [],
    low: []
  }

  for (const issue of issues) {
    grouped[issue.severity].push(issue)
  }

  return grouped
}

/**
 * Get emoji for severity level
 */
function getSeverityEmoji(severity: ReviewIssueSeverity): string {
  switch (severity) {
    case 'critical':
      return '🚨'
    case 'high':
      return '⚠️'
    case 'medium':
      return '⚡'
    case 'low':
      return '💡'
    default:
      return '•'
  }
}

/**
 * Get badge color for severity level
 */
function getSeverityBadge(severity: ReviewIssueSeverity): string {
  const severityUpper = severity.toUpperCase()
  switch (severity) {
    case 'critical':
      return '<kbd style="color: red; font-weight: bold;">CRITICAL</kbd>'
    case 'high':
      return '<kbd style="color: orange; font-weight: bold;">HIGH</kbd>'
    case 'medium':
      return '<kbd style="color: yellow; font-weight: bold;">MEDIUM</kbd>'
    case 'low':
      return '<kbd style="color: blue; font-weight: bold;">LOW</kbd>'
    default: {
      const _exhaustive: never = severity
      return `<kbd>${severityUpper}</kbd>`
    }
  }
}

/**
 * Count issues by severity
 *
 * @param issues - Array of review issues
 * @returns Object with counts per severity
 */
export function countIssuesBySeverity(issues: ReviewIssue[]): {
  critical: number
  high: number
  medium: number
  low: number
  total: number
} {
  const counts = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    total: issues.length
  }

  for (const issue of issues) {
    counts[issue.severity]++
  }

  return counts
}

/**
 * Truncate comment to fit GitHub's size limits
 * GitHub comments have a max size of 65536 characters
 *
 * @param markdown - Formatted markdown comment
 * @param maxLength - Maximum length (default: 65000 to be safe)
 * @returns Truncated markdown with warning if needed
 */
export function truncateComment(markdown: string, maxLength: number = 65000): string {
  if (markdown.length <= maxLength) {
    return markdown
  }

  const warning = '\n\n⚠️ **_Comment truncated due to size limits. See full review in workflow logs._**'
  const availableLength = maxLength - warning.length

  return markdown.substring(0, availableLength) + warning
}
