import { describe, it, expect } from 'vitest'
import { parseEnvFile, mergeEnvVars, resolveEnvForSpawn } from './env-parser'
import type { EnvVariable } from '@/types/project'

describe('env-parser', () => {
  describe('parseEnvFile', () => {
    it('should parse simple KEY=value pairs', () => {
      const content = 'NODE_ENV=development\nAPI_KEY=test123'
      const result = parseEnvFile(content)

      expect(result.vars).toHaveLength(2)
      expect(result.vars[0]).toEqual({ key: 'NODE_ENV', value: 'development' })
      expect(result.vars[1]).toEqual({ key: 'API_KEY', value: 'test123' })
      expect(result.invalidLines).toHaveLength(0)
    })

    it('should skip blank lines', () => {
      const content = 'KEY1=value1\n\n\nKEY2=value2'
      const result = parseEnvFile(content)

      expect(result.vars).toHaveLength(2)
    })

    it('should skip comment lines starting with #', () => {
      const content = '# This is a comment\nKEY=value\n# Another comment'
      const result = parseEnvFile(content)

      expect(result.vars).toHaveLength(1)
      expect(result.vars[0].key).toBe('KEY')
    })

    it('should strip double quotes from values', () => {
      const content = 'KEY="value with spaces"'
      const result = parseEnvFile(content)

      expect(result.vars[0].value).toBe('value with spaces')
    })

    it('should strip single quotes from values', () => {
      const content = "KEY='value with spaces'"
      const result = parseEnvFile(content)

      expect(result.vars[0].value).toBe('value with spaces')
    })

    it('should handle values with = signs', () => {
      const content = 'CONNECTION_STRING=host=localhost;port=5432'
      const result = parseEnvFile(content)

      expect(result.vars[0].value).toBe('host=localhost;port=5432')
    })

    it('should handle Windows line endings (CRLF)', () => {
      const content = 'KEY1=value1\r\nKEY2=value2'
      const result = parseEnvFile(content)

      expect(result.vars).toHaveLength(2)
    })

    it('should report invalid lines without = sign', () => {
      const content = 'VALID=value\nINVALID_LINE\nANOTHER=value'
      const result = parseEnvFile(content)

      expect(result.vars).toHaveLength(2)
      expect(result.invalidLines).toHaveLength(1)
      expect(result.invalidLines[0].line).toBe(2)
      expect(result.invalidLines[0].content).toBe('INVALID_LINE')
    })

    it('should report invalid keys (empty or special chars)', () => {
      const content = '=value\n123KEY=value\nVALID=value'
      const result = parseEnvFile(content)

      expect(result.vars).toHaveLength(1)
      expect(result.vars[0].key).toBe('VALID')
      expect(result.invalidLines.length).toBeGreaterThan(0)
    })

    it('should handle empty file', () => {
      const result = parseEnvFile('')

      expect(result.vars).toHaveLength(0)
      expect(result.invalidLines).toHaveLength(0)
    })

    it('should handle file with only comments and blank lines', () => {
      const content = '# Comment\n\n# Another comment\n'
      const result = parseEnvFile(content)

      expect(result.vars).toHaveLength(0)
      expect(result.invalidLines).toHaveLength(0)
    })
  })

  describe('mergeEnvVars', () => {
    it('should merge env vars with imported overwriting existing', () => {
      const existing: EnvVariable[] = [
        { key: 'KEY1', value: 'old1' },
        { key: 'KEY2', value: 'old2' }
      ]
      const imported: EnvVariable[] = [
        { key: 'KEY2', value: 'new2' },
        { key: 'KEY3', value: 'new3' }
      ]

      const result = mergeEnvVars(existing, imported)

      expect(result).toHaveLength(3)
      expect(result.find(v => v.key === 'KEY1')?.value).toBe('old1')
      expect(result.find(v => v.key === 'KEY2')?.value).toBe('new2')
      expect(result.find(v => v.key === 'KEY3')?.value).toBe('new3')
    })

    it('should handle empty existing array', () => {
      const imported: EnvVariable[] = [
        { key: 'KEY', value: 'value' }
      ]

      const result = mergeEnvVars([], imported)

      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('KEY')
    })

    it('should handle empty imported array', () => {
      const existing: EnvVariable[] = [
        { key: 'KEY', value: 'value' }
      ]

      const result = mergeEnvVars(existing, [])

      expect(result).toHaveLength(1)
      expect(result[0].key).toBe('KEY')
    })

    it('should preserve isSecret flag from imported vars', () => {
      const existing: EnvVariable[] = [
        { key: 'KEY', value: 'old' }
      ]
      const imported: EnvVariable[] = [
        { key: 'KEY', value: 'new', isSecret: true }
      ]

      const result = mergeEnvVars(existing, imported)

      expect(result[0].isSecret).toBe(true)
    })
  })

  describe('resolveEnvForSpawn', () => {
    it('should return empty env for undefined project env vars', () => {
      const result = resolveEnvForSpawn(undefined, {})

      expect(result.env).toEqual({})
      expect(result.hasProjectEnv).toBe(false)
    })

    it('should return empty env for empty project env vars', () => {
      const result = resolveEnvForSpawn([], {})

      expect(result.env).toEqual({})
      expect(result.hasProjectEnv).toBe(false)
    })

    it('should convert env vars to record', () => {
      const envVars: EnvVariable[] = [
        { key: 'NODE_ENV', value: 'production' },
        { key: 'PORT', value: '3000' }
      ]

      const result = resolveEnvForSpawn(envVars, {})

      expect(result.env).toEqual({
        NODE_ENV: 'production',
        PORT: '3000'
      })
      expect(result.hasProjectEnv).toBe(true)
    })

    it('should skip empty keys', () => {
      const envVars: EnvVariable[] = [
        { key: 'VALID', value: 'value' },
        { key: '', value: 'empty-key' },
        { key: '   ', value: 'whitespace-key' }
      ]

      const result = resolveEnvForSpawn(envVars, {})

      expect(result.env).toEqual({ VALID: 'value' })
    })

    it('should expand $VAR references against inherited env', () => {
      const envVars: EnvVariable[] = [
        { key: 'PATH_PREFIX', value: '$HOME/projects' }
      ]
      const inheritedEnv = { HOME: '/Users/test' }

      const result = resolveEnvForSpawn(envVars, inheritedEnv)

      expect(result.env.PATH_PREFIX).toBe('/Users/test/projects')
    })

    it('should expand ${VAR} references', () => {
      const envVars: EnvVariable[] = [
        { key: 'FULL_PATH', value: '${HOME}/workspace' }
      ]
      const inheritedEnv = { HOME: '/Users/test' }

      const result = resolveEnvForSpawn(envVars, inheritedEnv)

      expect(result.env.FULL_PATH).toBe('/Users/test/workspace')
    })

    it('should expand %VAR% references (Windows style)', () => {
      const envVars: EnvVariable[] = [
        { key: 'FULL_PATH', value: '%USERPROFILE%\\workspace' }
      ]
      const inheritedEnv = { USERPROFILE: 'C:\\Users\\test' }

      const result = resolveEnvForSpawn(envVars, inheritedEnv)

      expect(result.env.FULL_PATH).toBe('C:\\Users\\test\\workspace')
    })

    it('should replace missing var references with empty string', () => {
      const envVars: EnvVariable[] = [
        { key: 'PATH', value: '$UNDEFINED_VAR/path' }
      ]

      const result = resolveEnvForSpawn(envVars, {})

      expect(result.env.PATH).toBe('/path')
    })

    it('should NOT expand references against other project vars', () => {
      const envVars: EnvVariable[] = [
        { key: 'BASE', value: '/app' },
        { key: 'FULL', value: '$BASE/data' }
      ]

      const result = resolveEnvForSpawn(envVars, {})

      // $BASE should not be expanded because BASE is a project var, not inherited
      expect(result.env.BASE).toBe('/app')
      expect(result.env.FULL).toBe('/data') // $BASE resolves to empty
    })
  })
})