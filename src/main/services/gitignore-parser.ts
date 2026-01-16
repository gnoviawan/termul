/**
 * Gitignore Parser Service
 *
 * Parses .gitignore files and groups patterns by category.
 * Detects security-sensitive patterns and suggests related patterns.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { micromatch } from 'micromatch'

/**
 * Pattern categories for grouping
 */
export const PATTERN_CATEGORIES = {
  dependencies: ['node_modules/', 'vendor/', '.bundle/', 'jspm_packages/'],
  build: ['dist/', 'build/', 'out/', '.next/', '.nuxt/', 'cache/', '.cache/'],
  env: ['.env', '.env.local', '.env.*.local', '*.pem', '*.key', '*.cert'],
  cache: ['.eslintcache', '.stylelintcache', '*.log'],
  ide: ['.vscode/', '.idea/', '*.swp', '*.swo', '.DS_Store'],
  test: ['coverage/', '.nyc_output/', 'test-results/']
} as const

/**
 * Security-sensitive pattern detection
 */
const SECURITY_PATTERNS = [
  '.env',
  '.env.*',
  '*.env',
  '*.env.*',
  '*.pem',
  '*.key',
  '*.cert',
  'secrets.*',
  '*.secret',
  'credentials.*',
  'credentials'
]

/**
 * Related pattern mappings
 */
const RELATED_PATTERNS: Record<string, string[]> = {
  'node_modules/': ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.eslintcache', 'package.json'],
  'vendor/': ['composer.lock'],
  'dist/': ['build/', '.next/', 'out/'],
  '.env': ['.env.local', '.env.*.local']
}

/**
 * Pattern category
 */
export type PatternCategory = keyof typeof PATTERN_CATEGORIES | 'other'

/**
 * Parsed pattern with metadata
 */
export interface ParsedPattern {
  pattern: string
  category: PatternCategory
  isSecuritySensitive: boolean
  relatedPatterns: string[]
}

/**
 * Gitignore parse result
 */
export interface GitignoreParseResult {
  patterns: ParsedPattern[]
  groupedPatterns: Map<PatternCategory, ParsedPattern[]>
  securityPatterns: ParsedPattern[]
}

/**
 * Parse .gitignore file and categorize patterns
 */
export async function parseGitignore(projectRoot: string): Promise<GitignoreParseResult> {
  const gitignorePath = path.join(projectRoot, '.gitignore')

  try {
    const content = await fs.readFile(gitignorePath, 'utf-8')
    const lines = content.split('\n').filter(line => {
      // Remove comments and empty lines
      const trimmed = line.trim()
      return trimmed && !trimmed.startsWith('#')
    })

    const parsedPatterns: ParsedPattern[] = lines.map(line => {
      const pattern = line.trim()
      const category = categorizePattern(pattern)
      const isSecuritySensitive = SECURITY_PATTERNS.some(securityPattern =>
        micromatch(pattern, securityPattern)
      )
      const relatedPatterns = RELATED_PATTERNS[pattern] || []

      return { pattern, category, isSecuritySensitive, relatedPatterns }
    })

    // Group patterns by category
    const groupedPatterns = new Map<PatternCategory, ParsedPattern[]>()
    Object.keys(PATTERN_CATEGORIES).forEach(cat => {
      const category = cat as PatternCategory
      const patternsInCategory = parsedPatterns.filter(p => p.category === category)
      if (patternsInCategory.length > 0) {
        groupedPatterns.set(category, patternsInCategory)
      }
    })

    // Add 'other' category if exists
    const otherPatterns = parsedPatterns.filter(p => p.category === 'other')
    if (otherPatterns.length > 0) {
      groupedPatterns.set('other', otherPatterns)
    }

    // Extract security patterns
    const securityPatterns = parsedPatterns.filter(p => p.isSecuritySensitive)

    return {
      patterns: parsedPatterns,
      groupedPatterns,
      securityPatterns
    }
  } catch (error) {
    // If .gitignore doesn't exist, return empty result
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        patterns: [],
        groupedPatterns: new Map(),
        securityPatterns: []
      }
    }
    throw error
  }
}

/**
 * Categorize a pattern
 */
function categorizePattern(pattern: string): PatternCategory {
  for (const [category, patterns] of Object.entries(PATTERN_CATEGORIES)) {
    for (const categoryPattern of patterns) {
      // Check if pattern matches or starts with the category pattern
      if (pattern === categoryPattern || pattern.startsWith(categoryPattern.replace('*', ''))) {
        return category as PatternCategory
      }
    }
  }
  return 'other'
}

/**
 * Get related patterns for a given pattern
 */
export function getRelatedPatterns(pattern: string): string[] {
  return RELATED_PATTERNS[pattern] || []
}

/**
 * Get security warnings for patterns
 */
export function getSecurityWarnings(patterns: string[]): string[] {
  const warnings: string[] = []

  for (const pattern of patterns) {
    for (const securityPattern of SECURITY_PATTERNS) {
      if (micromatch(pattern, securityPattern)) {
        warnings.push(`Pattern "${pattern}" may contain sensitive credentials`)
        break
      }
    }
  }

  return warnings
}

/**
 * Check if a pattern is security-sensitive
 */
export function isSecuritySensitive(pattern: string): boolean {
  return SECURITY_PATTERNS.some(securityPattern =>
    micromatch(pattern, securityPattern)
  )
}
