import { describe, it, expect } from 'vitest'
import {
  formatComment,
  formatLineComment,
  formatNoIssuesComment,
  countIssuesBySeverity,
  truncateComment,
  type ReviewFeedback,
  type ReviewIssue,
  type ReviewIssueSeverity,
  type FormatCommentOptions
} from '../../.github/actions/code-reviewer/comment-formatter'

describe('formatComment', () => {
  describe('basic formatting', () => {
    it('should format feedback with summary and issues', () => {
      const feedback: ReviewFeedback = {
        summary: 'Code review completed successfully',
        issues: [
          {
            severity: 'high',
            file: 'src/app.ts',
            line: 10,
            issue: 'Missing error handling',
            suggestion: 'Add try-catch block'
          }
        ]
      }

      const result = formatComment(feedback)

      expect(result).toContain('<!-- code-reviewer-comment -->')
      expect(result).toContain('# 🤖 Code Review Report')
      expect(result).toContain('## 📝 Summary')
      expect(result).toContain(feedback.summary)
      expect(result).toContain('## 🔍 Issues Found')
      expect(result).toContain('Missing error handling')
      expect(result).toContain('Add try-catch block')
      expect(result).toContain('<!-- /code-reviewer-comment -->')
    })

    it('should format feedback with no issues', () => {
      const feedback: ReviewFeedback = {
        summary: 'Everything looks good',
        issues: [],
        positiveFeedback: ['Clean code structure', 'Good naming']
      }

      const result = formatComment(feedback)

      expect(result).toContain(feedback.summary)
      expect(result).toContain('Clean code structure')
      expect(result).toContain('Good naming')
      expect(result).not.toContain('## 🔍 Issues Found')
    })

    it('should include header and footer markers', () => {
      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues: []
      }

      const result = formatComment(feedback)

      expect(result.startsWith('<!-- code-reviewer-comment -->\n\n# 🤖 Code Review Report\n\n')).toBe(true)
      expect(result.endsWith('<!-- /code-reviewer-comment -->\n')).toBe(true)
    })
  })

  describe('severity grouping', () => {
    it('should group issues by severity when groupBySeverity is true', () => {
      const feedback: ReviewFeedback = {
        summary: 'Review done',
        issues: [
          { severity: 'low', file: 'file1.ts', issue: 'Minor style', suggestion: 'Fix it' },
          { severity: 'critical', file: 'file2.ts', issue: 'Security bug', suggestion: 'Fix now' },
          { severity: 'high', file: 'file3.ts', issue: 'Major bug', suggestion: 'Fix soon' }
        ]
      }

      const result = formatComment(feedback, { groupBySeverity: true })

      // Should have sections in order: critical, high, medium, low
      // Medium section is not shown because it has 0 issues
      expect(result).toContain('### 🚨 CRITICAL (1)')
      expect(result).toContain('### ⚠️ HIGH (1)')
      expect(result).toContain('### 💡 LOW (1)')
      expect(result).not.toContain('### ⚡ MEDIUM')
    })

    it('should display issues as flat list when groupBySeverity is false', () => {
      const feedback: ReviewFeedback = {
        summary: 'Review done',
        issues: [
          { severity: 'low', file: 'file1.ts', issue: 'Minor style', suggestion: 'Fix it' },
          { severity: 'critical', file: 'file2.ts', issue: 'Security bug', suggestion: 'Fix now' }
        ]
      }

      const result = formatComment(feedback, { groupBySeverity: false })

      expect(result).toContain('## 🔍 Issues Found (2)')
      expect(result).not.toContain('### 🚨 CRITICAL')
      expect(result).not.toContain('### 💡 LOW')
    })
  })

  describe('severity badges and emojis', () => {
    it('should use correct emoji for each severity', () => {
      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues: [
          { severity: 'critical', file: 'a.ts', issue: 'C', suggestion: 'S' },
          { severity: 'high', file: 'b.ts', issue: 'H', suggestion: 'S' },
          { severity: 'medium', file: 'c.ts', issue: 'M', suggestion: 'S' },
          { severity: 'low', file: 'd.ts', issue: 'L', suggestion: 'S' }
        ]
      }

      const result = formatComment(feedback)

      expect(result).toContain('🚨') // critical
      expect(result).toContain('⚠️') // high
      expect(result).toContain('⚡') // medium
      expect(result).toContain('💡') // low
    })

    it('should use colored badges for severity', () => {
      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues: [
          { severity: 'critical', file: 'a.ts', issue: 'C', suggestion: 'S' }
        ]
      }

      const result = formatComment(feedback)

      expect(result).toContain('<kbd style="color: red; font-weight: bold;">CRITICAL</kbd>')
    })
  })

  describe('line number formatting', () => {
    it('should include line numbers when includeLineNumbers is true', () => {
      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues: [
          { severity: 'high', file: 'src/app.ts', line: 42, issue: 'Bug', suggestion: 'Fix' }
        ]
      }

      const result = formatComment(feedback, { includeLineNumbers: true })

      expect(result).toContain('`src/app.ts:42`')
    })

    it('should not include line numbers when includeLineNumbers is false', () => {
      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues: [
          { severity: 'high', file: 'src/app.ts', line: 42, issue: 'Bug', suggestion: 'Fix' }
        ]
      }

      const result = formatComment(feedback, { includeLineNumbers: false })

      expect(result).toContain('`src/app.ts`')
      expect(result).not.toContain(':42')
    })

    it('should handle issues without line numbers', () => {
      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues: [
          { severity: 'high', file: 'src/app.ts', issue: 'Bug', suggestion: 'Fix' }
        ]
      }

      const result = formatComment(feedback)

      expect(result).toContain('`src/app.ts`')
      expect(result).not.toContain('src/app.ts:')
    })
  })

  describe('issue limiting', () => {
    it('should limit issues per severity with maxIssuesPerSeverity', () => {
      const issues: ReviewIssue[] = Array.from({ length: 15 }, (_, i) => ({
        severity: 'low' as ReviewIssueSeverity,
        file: `file${i}.ts`,
        issue: `Issue ${i}`,
        suggestion: `Fix ${i}`
      }))

      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues
      }

      const result = formatComment(feedback, { maxIssuesPerSeverity: 10 })

      // Should show only 10 issues with hidden message
      expect(result).toContain('more low issues hidden')
    })

    it('should show hidden issues message', () => {
      const issues: ReviewIssue[] = Array.from({ length: 12 }, (_, i) => ({
        severity: 'high' as ReviewIssueSeverity,
        file: `file${i}.ts`,
        issue: `Issue ${i}`,
        suggestion: `Fix ${i}`
      }))

      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues
      }

      const result = formatComment(feedback, { maxIssuesPerSeverity: 10, groupBySeverity: false })

      expect(result).toContain('more issues hidden')
    })
  })

  describe('reason field', () => {
    it('should include reason when provided', () => {
      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues: [
          {
            severity: 'high',
            file: 'app.ts',
            issue: 'Bug',
            suggestion: 'Fix it',
            reason: 'This causes undefined behavior'
          }
        ]
      }

      const result = formatComment(feedback)

      expect(result).toContain('**Why:** This causes undefined behavior')
    })

    it('should not include reason when not provided', () => {
      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues: [
          {
            severity: 'high',
            file: 'app.ts',
            issue: 'Bug',
            suggestion: 'Fix it'
          }
        ]
      }

      const result = formatComment(feedback)

      expect(result).not.toContain('**Why:**')
    })
  })

  describe('additional sections', () => {
    it('should include security considerations', () => {
      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues: [],
        security: ['SQL injection vulnerability', 'XSS attack vector']
      }

      const result = formatComment(feedback)

      expect(result).toContain('## 🔒 Security Considerations')
      expect(result).toContain('⚠️ SQL injection vulnerability')
      expect(result).toContain('⚠️ XSS attack vector')
    })

    it('should include performance considerations', () => {
      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues: [],
        performance: ['Inefficient loop', 'Missing cache']
      }

      const result = formatComment(feedback)

      expect(result).toContain('## ⚡ Performance Considerations')
      expect(result).toContain('📊 Inefficient loop')
      expect(result).toContain('📊 Missing cache')
    })

    it('should include best practices', () => {
      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues: [],
        bestPractices: ['Add type annotations', 'Use const instead of let']
      }

      const result = formatComment(feedback)

      expect(result).toContain('## 💡 Best Practices')
      expect(result).toContain('✨ Add type annotations')
      expect(result).toContain('✨ Use const instead of let')
    })

    it('should include positive feedback', () => {
      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues: [],
        positiveFeedback: ['Clean code', 'Good tests']
      }

      const result = formatComment(feedback)

      expect(result).toContain('## ✨ What Was Done Well')
      expect(result).toContain('🎉 Clean code')
      expect(result).toContain('🎉 Good tests')
    })

    it('should not include positive feedback when includePositiveFeedback is false', () => {
      const feedback: ReviewFeedback = {
        summary: 'Test',
        issues: [],
        positiveFeedback: ['Clean code']
      }

      const result = formatComment(feedback, { includePositiveFeedback: false })

      expect(result).not.toContain('## ✨ What Was Done Well')
      expect(result).not.toContain('Clean code')
    })

    it('should not include summary when includeSummary is false', () => {
      const feedback: ReviewFeedback = {
        summary: 'This should not appear',
        issues: []
      }

      const result = formatComment(feedback, { includeSummary: false })

      expect(result).not.toContain('## 📝 Summary')
      expect(result).not.toContain('This should not appear')
    })
  })

  describe('all sections together', () => {
    it('should format feedback with all sections', () => {
      const feedback: ReviewFeedback = {
        summary: 'Comprehensive review',
        issues: [
          { severity: 'critical', file: 'auth.ts', line: 10, issue: 'Auth bypass', suggestion: 'Fix auth' }
        ],
        security: ['Check authentication'],
        performance: ['Optimize query'],
        bestPractices: ['Add error handling'],
        positiveFeedback: ['Good structure']
      }

      const result = formatComment(feedback)

      expect(result).toContain('## 📝 Summary')
      expect(result).toContain('## 🔍 Issues Found')
      expect(result).toContain('## 🔒 Security Considerations')
      expect(result).toContain('## ⚡ Performance Considerations')
      expect(result).toContain('## 💡 Best Practices')
      expect(result).toContain('## ✨ What Was Done Well')
    })
  })
})

describe('formatLineComment', () => {
  it('should format a line comment with severity emoji', () => {
    const issue: ReviewIssue = {
      severity: 'high',
      file: 'app.ts',
      line: 42,
      issue: 'Missing error handling',
      suggestion: 'Add try-catch block'
    }

    const result = formatLineComment(issue)

    expect(result).toContain('⚠️')
    expect(result).toContain('**HIGH**')
    expect(result).toContain('Missing error handling')
    expect(result).toContain('**Suggestion:** Add try-catch block')
  })

  it('should format critical severity', () => {
    const issue: ReviewIssue = {
      severity: 'critical',
      file: 'app.ts',
      issue: 'Bug',
      suggestion: 'Fix'
    }

    const result = formatLineComment(issue)

    expect(result).toContain('🚨')
    expect(result).toContain('**CRITICAL**')
  })

  it('should format medium severity', () => {
    const issue: ReviewIssue = {
      severity: 'medium',
      file: 'app.ts',
      issue: 'Style issue',
      suggestion: 'Fix'
    }

    const result = formatLineComment(issue)

    expect(result).toContain('⚡')
    expect(result).toContain('**MEDIUM**')
  })

  it('should format low severity', () => {
    const issue: ReviewIssue = {
      severity: 'low',
      file: 'app.ts',
      issue: 'Minor issue',
      suggestion: 'Fix'
    }

    const result = formatLineComment(issue)

    expect(result).toContain('💡')
    expect(result).toContain('**LOW**')
  })

  it('should not require line number', () => {
    const issue: ReviewIssue = {
      severity: 'high',
      file: 'app.ts',
      issue: 'General issue',
      suggestion: 'Fix it'
    }

    const result = formatLineComment(issue)

    expect(result).toContain('General issue')
    expect(result).toContain('Fix it')
  })
})

describe('formatNoIssuesComment', () => {
  it('should format success comment', () => {
    const result = formatNoIssuesComment('Code looks great!')

    expect(result).toContain('<!-- code-reviewer-comment -->')
    expect(result).toContain('# 🤖 Code Review Report')
    expect(result).toContain('## ✅ Review Results')
    expect(result).toContain('**No issues found!** The code changes look good.')
    expect(result).toContain('Code looks great!')
    expect(result).toContain('<!-- /code-reviewer-comment -->')
  })

  it('should include positive feedback when provided', () => {
    const result = formatNoIssuesComment('Good code', ['Clean structure', 'Good tests'])

    expect(result).toContain('### What Was Done Well')
    expect(result).toContain('- ✨ Clean structure')
    expect(result).toContain('- ✨ Good tests')
  })

  it('should handle empty positive feedback array', () => {
    const result = formatNoIssuesComment('Good code', [])

    expect(result).not.toContain('### What Was Done Well')
  })

  it('should handle undefined positive feedback', () => {
    const result = formatNoIssuesComment('Good code')

    expect(result).not.toContain('### What Was Done Well')
  })

  it('should handle empty summary', () => {
    const result = formatNoIssuesComment('')

    expect(result).toContain('## ✅ Review Results')
    expect(result).not.toContain('### Summary')
  })
})

describe('countIssuesBySeverity', () => {
  it('should count issues by severity', () => {
    const issues: ReviewIssue[] = [
      { severity: 'critical', file: 'a.ts', issue: 'C', suggestion: 'S' },
      { severity: 'critical', file: 'b.ts', issue: 'C2', suggestion: 'S' },
      { severity: 'high', file: 'c.ts', issue: 'H', suggestion: 'S' },
      { severity: 'high', file: 'd.ts', issue: 'H2', suggestion: 'S' },
      { severity: 'high', file: 'e.ts', issue: 'H3', suggestion: 'S' },
      { severity: 'medium', file: 'f.ts', issue: 'M', suggestion: 'S' },
      { severity: 'low', file: 'g.ts', issue: 'L', suggestion: 'S' }
    ]

    const result = countIssuesBySeverity(issues)

    expect(result.critical).toBe(2)
    expect(result.high).toBe(3)
    expect(result.medium).toBe(1)
    expect(result.low).toBe(1)
    expect(result.total).toBe(7)
  })

  it('should handle empty issues array', () => {
    const result = countIssuesBySeverity([])

    expect(result.critical).toBe(0)
    expect(result.high).toBe(0)
    expect(result.medium).toBe(0)
    expect(result.low).toBe(0)
    expect(result.total).toBe(0)
  })

  it('should count only one severity', () => {
    const issues: ReviewIssue[] = [
      { severity: 'low', file: 'a.ts', issue: 'L1', suggestion: 'S' },
      { severity: 'low', file: 'b.ts', issue: 'L2', suggestion: 'S' },
      { severity: 'low', file: 'c.ts', issue: 'L3', suggestion: 'S' }
    ]

    const result = countIssuesBySeverity(issues)

    expect(result.critical).toBe(0)
    expect(result.high).toBe(0)
    expect(result.medium).toBe(0)
    expect(result.low).toBe(3)
    expect(result.total).toBe(3)
  })

  it('should calculate total correctly', () => {
    const issues: ReviewIssue[] = Array.from({ length: 100 }, (_, i) => ({
      severity: ['critical', 'high', 'medium', 'low'][i % 4] as ReviewIssueSeverity,
      file: `file${i}.ts`,
      issue: `Issue ${i}`,
      suggestion: `Fix ${i}`
    }))

    const result = countIssuesBySeverity(issues)

    expect(result.total).toBe(100)
    expect(result.critical + result.high + result.medium + result.low).toBe(100)
  })
})

describe('truncateComment', () => {
  it('should not truncate short comments', () => {
    const comment = 'Short comment'

    const result = truncateComment(comment, 1000)

    expect(result).toBe(comment)
    expect(result.length).toBe(comment.length)
  })

  it('should not truncate comments at exact max length', () => {
    const comment = 'A'.repeat(1000)

    const result = truncateComment(comment, 1000)

    expect(result).toBe(comment)
    expect(result.length).toBe(1000)
  })

  it('should truncate long comments', () => {
    const longComment = 'A'.repeat(70000)
    const maxLength = 65000

    const result = truncateComment(longComment, maxLength)

    expect(result.length).toBeLessThanOrEqual(maxLength)
    expect(result).toContain('⚠️ **_Comment truncated due to size limits')
  })

  it('should add truncation warning message', () => {
    const longComment = 'A'.repeat(70000)

    const result = truncateComment(longComment, 65000)

    expect(result).toContain('Comment truncated due to size limits. See full review in workflow logs.')
    expect(result).toContain('⚠️ **_')
    expect(result).toContain('_**')
  })

  it('should use default max length of 65000', () => {
    const longComment = 'A'.repeat(70000)

    const result = truncateComment(longComment)

    expect(result.length).toBeLessThanOrEqual(65000)
  })

  it('should preserve content up to max length', () => {
    const comment = 'Important content at start'
    const extra = 'B'.repeat(70000)
    const fullComment = comment + extra

    const result = truncateComment(fullComment, 100)

    // The result is truncated, so it won't start with the full comment
    // But it should contain the beginning of the comment
    expect(result).toContain('Important content')
    expect(result).toContain('⚠️')
  })

  it('should calculate available length correctly', () => {
    const warning = '\n\n⚠️ **_Comment truncated due to size limits. See full review in workflow logs._**'
    const maxLength = 1000
    const availableLength = maxLength - warning.length
    const comment = 'A'.repeat(availableLength + 100)

    const result = truncateComment(comment, maxLength)

    // Result should be exactly maxLength
    expect(result.length).toBe(maxLength)
    // Should have all A's possible plus warning
    expect(result.substring(0, availableLength)).toBe('A'.repeat(availableLength))
  })
})

describe('formatting edge cases', () => {
  it('should handle empty feedback object', () => {
    const feedback: ReviewFeedback = {
      summary: '',
      issues: []
    }

    const result = formatComment(feedback)

    expect(result).toContain('<!-- code-reviewer-comment -->')
    expect(result).toContain('<!-- /code-reviewer-comment -->')
  })

  it('should handle special characters in issue text', () => {
    const feedback: ReviewFeedback = {
      summary: 'Test with <script> and & characters',
      issues: [
        {
          severity: 'high',
          file: 'app.ts',
          issue: 'Issue with "quotes" and \'apostrophes\'',
          suggestion: 'Use `backticks` for code'
        }
      ]
    }

    const result = formatComment(feedback)

    expect(result).toContain('<script>')
    expect(result).toContain('&')
    expect(result).toContain('"quotes"')
    expect(result).toContain('\'apostrophes\'')
    expect(result).toContain('`backticks`')
  })

  it('should handle very long issue descriptions', () => {
    const longIssue = 'Issue '.repeat(1000)
    const feedback: ReviewFeedback = {
      summary: 'Test',
      issues: [
        {
          severity: 'high',
          file: 'app.ts',
          issue: longIssue,
          suggestion: 'Fix it'
        }
      ]
    }

    const result = formatComment(feedback)

    expect(result).toContain(longIssue)
  })

  it('should handle issues with Unicode characters', () => {
    const feedback: ReviewFeedback = {
      summary: 'Review with emoji 🎉 and 中文',
      issues: [
        {
          severity: 'high',
          file: 'app.ts',
          issue: 'Issue with العربية and 🚨',
          suggestion: 'Fix with emoji 💡'
        }
      ]
    }

    const result = formatComment(feedback)

    expect(result).toContain('🎉')
    expect(result).toContain('中文')
    expect(result).toContain('العربية')
    expect(result).toContain('🚨')
    expect(result).toContain('💡')
  })

  it('should handle multiple issues in same file', () => {
    const feedback: ReviewFeedback = {
      summary: 'Test',
      issues: [
        { severity: 'high', file: 'app.ts', line: 10, issue: 'Issue 1', suggestion: 'Fix 1' },
        { severity: 'medium', file: 'app.ts', line: 20, issue: 'Issue 2', suggestion: 'Fix 2' },
        { severity: 'low', file: 'app.ts', line: 30, issue: 'Issue 3', suggestion: 'Fix 3' }
      ]
    }

    const result = formatComment(feedback)

    expect(result).toContain('app.ts:10')
    expect(result).toContain('app.ts:20')
    expect(result).toContain('app.ts:30')
    expect(result).toContain('Issue 1')
    expect(result).toContain('Issue 2')
    expect(result).toContain('Issue 3')
  })
})
