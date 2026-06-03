/**
 * Unit tests for the Agent Registry builder (ADR-004.3).
 *
 * `buildAgentArgv` is the pure boundary that turns an agent definition + prompt
 * into argv. The security guarantee (prompt is a discrete argv element, never
 * shell-interpolated) is enforced downstream in Rust, but these tests pin the
 * argv shape for every prompt mode and the gotchas the ADR called out.
 */
import { describe, expect, it } from 'vitest'
import {
  BUILT_IN_AGENTS,
  buildAgentArgv,
  getBuiltInAgent,
  type TerminalAgentDefinition
} from '@/lib/agents/agent-registry'

const make = (over: Partial<TerminalAgentDefinition>): TerminalAgentDefinition => ({
  id: 'x',
  name: 'X',
  command: 'x',
  baseArgs: [],
  promptMode: 'positional',
  isBuiltIn: true,
  ...over
})

describe('buildAgentArgv', () => {
  it('positional: appends the prompt as the final argv element', () => {
    const def = make({ command: 'claude', promptMode: 'positional' })
    expect(buildAgentArgv(def, 'explain this project')).toEqual({
      program: 'claude',
      args: ['explain this project']
    })
  })

  it('flag: places the prompt right after the prompt flag', () => {
    const def = make({ command: 'gemini', promptMode: 'flag', promptFlag: '-i' })
    expect(buildAgentArgv(def, 'query')).toEqual({
      program: 'gemini',
      args: ['-i', 'query']
    })
  })

  it('flag with --prompt (OpenCode): never uses a positional project path', () => {
    const def = make({
      command: 'opencode',
      promptMode: 'flag',
      promptFlag: '--prompt'
    })
    expect(buildAgentArgv(def, 'add unit tests')).toEqual({
      program: 'opencode',
      args: ['--prompt', 'add unit tests']
    })
  })

  it('none: ignores the prompt entirely', () => {
    const def = make({ command: 'pi', promptMode: 'none' })
    expect(buildAgentArgv(def, 'whatever the user typed')).toEqual({
      program: 'pi',
      args: []
    })
  })

  it('prepends baseArgs before the prompt', () => {
    const def = make({ command: 'agent', baseArgs: ['--flag', 'v'], promptMode: 'positional' })
    expect(buildAgentArgv(def, 'go')).toEqual({
      program: 'agent',
      args: ['--flag', 'v', 'go']
    })
  })

  it('treats undefined / empty / whitespace prompt as no prompt', () => {
    const positional = make({ command: 'claude', promptMode: 'positional' })
    expect(buildAgentArgv(positional, undefined).args).toEqual([])
    expect(buildAgentArgv(positional, '').args).toEqual([])
    expect(buildAgentArgv(positional, '   \t\n').args).toEqual([])

    const flag = make({ command: 'gemini', promptMode: 'flag', promptFlag: '-i' })
    expect(buildAgentArgv(flag, '   ').args).toEqual([])
  })

  it('flag mode without promptFlag drops the prompt rather than guessing', () => {
    const def = make({ command: 'agent', promptMode: 'flag' })
    expect(buildAgentArgv(def, 'prompt').args).toEqual([])
  })

  it('passes shell metacharacters through verbatim as a single argv element', () => {
    const def = make({ command: 'claude', promptMode: 'positional' })
    const dangerous = '"; rm -rf ~ # `whoami` && echo $(id)'
    const { args } = buildAgentArgv(def, dangerous)
    expect(args).toHaveLength(1)
    expect(args[0]).toBe(dangerous)
  })

  it('preserves a multi-line prompt as one argument', () => {
    const def = make({ command: 'claude', promptMode: 'positional' })
    const { args } = buildAgentArgv(def, 'line1\nline2')
    expect(args).toEqual(['line1\nline2'])
  })

  it('does not mutate the definition baseArgs array', () => {
    const baseArgs = ['-i']
    const def = make({ command: 'gemini', baseArgs, promptMode: 'flag', promptFlag: '-i' })
    buildAgentArgv(def, 'q')
    expect(baseArgs).toEqual(['-i'])
  })
})

describe('built-in agent definitions', () => {
  it('match the validated ADR-004 launch conventions', () => {
    const byId = Object.fromEntries(BUILT_IN_AGENTS.map((a) => [a.id, a]))
    expect(byId['claude-code']).toMatchObject({ command: 'claude', promptMode: 'positional' })
    expect(byId.codex).toMatchObject({ command: 'codex', promptMode: 'positional' })
    expect(byId.cursor).toMatchObject({ command: 'cursor-agent', promptMode: 'positional' })
    expect(byId['gemini-cli']).toMatchObject({
      command: 'gemini',
      promptMode: 'flag',
      promptFlag: '-i'
    })
    expect(byId.opencode).toMatchObject({
      command: 'opencode',
      promptMode: 'flag',
      promptFlag: '--prompt'
    })
    expect(byId.pi).toMatchObject({ command: 'pi', promptMode: 'positional' })
  })

  it('every flag-mode built-in declares a promptFlag', () => {
    for (const agent of BUILT_IN_AGENTS) {
      if (agent.promptMode === 'flag') {
        expect(agent.promptFlag, `${agent.id} must declare promptFlag`).toBeTruthy()
      }
    }
  })

  it('all built-ins are flagged isBuiltIn and have unique ids', () => {
    const ids = BUILT_IN_AGENTS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(BUILT_IN_AGENTS.every((a) => a.isBuiltIn)).toBe(true)
  })

  it('produces the exact documented argv for each built-in', () => {
    expect(buildAgentArgv(getBuiltInAgent('claude-code')!, 'P')).toEqual({
      program: 'claude',
      args: ['P']
    })
    expect(buildAgentArgv(getBuiltInAgent('cursor')!, 'P')).toEqual({
      program: 'cursor-agent',
      args: ['P']
    })
    expect(buildAgentArgv(getBuiltInAgent('gemini-cli')!, 'P')).toEqual({
      program: 'gemini',
      args: ['-i', 'P']
    })
    expect(buildAgentArgv(getBuiltInAgent('opencode')!, 'P')).toEqual({
      program: 'opencode',
      args: ['--prompt', 'P']
    })
    expect(buildAgentArgv(getBuiltInAgent('pi')!, 'P')).toEqual({ program: 'pi', args: ['P'] })
  })

  it('getBuiltInAgent returns undefined for unknown ids', () => {
    expect(getBuiltInAgent('does-not-exist')).toBeUndefined()
  })
})
