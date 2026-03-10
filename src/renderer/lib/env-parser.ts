import type { EnvVariable } from '@/types/project'

/**
 * Result of parsing a .env file
 */
export interface EnvParseResult {
  /** Successfully parsed environment variables */
  vars: EnvVariable[]
  /** Lines that couldn't be parsed (line number + raw content) */
  invalidLines: Array<{ line: number; content: string }>
}

/**
 * Parse a .env file content into environment variables.
 *
 * Supports:
 * - KEY=value pairs
 * - Comments starting with #
 * - Blank lines (ignored)
 * - Quoted values (single or double quotes, stripped)
 * - Values containing = signs
 *
 * Does NOT support:
 * - Variable expansion/substitution
 * - Multi-line values
 * - Shell command execution
 *
 * @param content - Raw .env file content
 * @returns Parsed environment variables and any invalid lines
 */
export function parseEnvFile(content: string): EnvParseResult {
  const lines = content.split(/\r?\n/)
  const vars: EnvVariable[] = []
  const invalidLines: Array<{ line: number; content: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1
    const rawLine = lines[i]
    const line = rawLine.trim()

    // Skip empty lines
    if (line === '') {
      continue
    }

    // Skip comments
    if (line.startsWith('#')) {
      continue
    }

    // Find first = sign
    const eqIndex = line.indexOf('=')
    if (eqIndex === -1) {
      // No = sign, invalid line
      invalidLines.push({ line: lineNum, content: rawLine })
      continue
    }

    const key = line.slice(0, eqIndex).trim()
    let value = line.slice(eqIndex + 1)

    // Validate key (must be non-empty and contain only valid chars)
    if (key === '' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      invalidLines.push({ line: lineNum, content: rawLine })
      continue
    }

    // Strip surrounding quotes from value
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    vars.push({ key, value })
  }

  return { vars, invalidLines }
}

/**
 * Merge parsed env vars into existing env vars.
 * Imported keys overwrite existing keys with the same name.
 *
 * @param existing - Current environment variables
 * @param imported - New variables from .env import
 * @returns Merged environment variables list
 */
export function mergeEnvVars(
  existing: EnvVariable[],
  imported: EnvVariable[]
): EnvVariable[] {
  const merged = new Map<string, EnvVariable>()

  // Add existing vars first
  for (const envVar of existing) {
    merged.set(envVar.key, envVar)
  }

  // Overwrite with imported vars
  for (const envVar of imported) {
    merged.set(envVar.key, envVar)
  }

  return Array.from(merged.values())
}

/**
 * Result of resolving project env vars for spawn
 */
export interface ResolvedEnvResult {
  /** Resolved environment map for spawn */
  env: Record<string, string>
  /** Whether any project env vars were applied */
  hasProjectEnv: boolean
}

/**
 * Resolve project environment variables for terminal spawn.
 *
 * Expands variable references against inherited system/process environment only.
 * Does NOT expand against other project-defined vars.
 *
 * Supported reference formats:
 * - Unix: $VAR, ${VAR}
 * - Windows: %VAR%
 *
 * @param projectEnvVars - Project's saved environment variables
 * @param inheritedEnv - Inherited system/process environment (from window or backend)
 * @returns Resolved environment map and metadata
 */
export function resolveEnvForSpawn(
  projectEnvVars: EnvVariable[] | undefined,
  inheritedEnv: Record<string, string> = {}
): ResolvedEnvResult {
  if (!projectEnvVars || projectEnvVars.length === 0) {
    return { env: {}, hasProjectEnv: false }
  }

  const resolved: Record<string, string> = {}

  for (const envVar of projectEnvVars) {
    if (!envVar.key || envVar.key.trim() === '') {
      continue
    }

    // Expand variable references against inherited environment only
    const expandedValue = expandEnvReferences(envVar.value, inheritedEnv)
    resolved[envVar.key] = expandedValue
  }

  return {
    env: resolved,
    hasProjectEnv: Object.keys(resolved).length > 0
  }
}

/**
 * Expand environment variable references in a value.
 *
 * Supports:
 * - Unix style: $VAR or ${VAR}
 * - Windows style: %VAR%
 *
 * @param value - The value containing potential variable references
 * @param env - Environment to resolve references against
 * @returns Expanded value
 */
function expandEnvReferences(value: string, env: Record<string, string>): string {
  // Handle ${VAR} syntax
  let result = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, varName) => {
    return env[varName] ?? ''
  })

  // Handle $VAR syntax (not followed by { which was already handled)
  result = result.replace(/\$([A-Za-z_][A-Za-z0-9_]*)(?![{A-Za-z0-9_])/g, (_, varName) => {
    return env[varName] ?? ''
  })

  // Handle %VAR% syntax (Windows style)
  result = result.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, varName) => {
    return env[varName] ?? ''
  })

  return result
}