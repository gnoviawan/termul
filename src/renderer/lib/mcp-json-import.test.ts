import { describe, expect, it } from 'vitest'
import { parseMcpJsonImport } from './mcp-json-import'

describe('parseMcpJsonImport', () => {
  it('parses a Claude Desktop wrapper and normalizes the env map to name/value pairs', () => {
    const { servers, errors } = parseMcpJsonImport(
      JSON.stringify({
        mcpServers: {
          dokploy: {
            command: 'npx',
            args: ['-y', '@dokploy/mcp'],
            env: { DOKPLOY_URL: 'https://dokploy.test', DOKPLOY_API_KEY: 'secret' }
          }
        }
      })
    )
    expect(errors).toEqual([])
    expect(servers).toEqual([
      {
        type: 'stdio',
        name: 'dokploy',
        command: 'npx',
        args: ['-y', '@dokploy/mcp'],
        env: [
          { name: 'DOKPLOY_URL', value: 'https://dokploy.test' },
          { name: 'DOKPLOY_API_KEY', value: 'secret' }
        ]
      }
    ])
  })

  it('parses a bare single-server object using its name field', () => {
    const { servers, errors } = parseMcpJsonImport(
      JSON.stringify({
        command: 'npx',
        args: ['-y', '@dokploy/mcp'],
        env: { DOKPLOY_URL: 'https://dokploy.test' },
        name: 'dokploy'
      })
    )
    expect(errors).toEqual([])
    expect(servers).toEqual([
      {
        type: 'stdio',
        name: 'dokploy',
        command: 'npx',
        args: ['-y', '@dokploy/mcp'],
        env: [{ name: 'DOKPLOY_URL', value: 'https://dokploy.test' }]
      }
    ])
  })

  it('drops unknown fields such as directTools and alwaysAllow', () => {
    const { servers, errors } = parseMcpJsonImport(
      JSON.stringify({
        mcpServers: {
          x: {
            command: 'node',
            args: ['server.js'],
            directTools: true,
            alwaysAllow: ['read']
          }
        }
      })
    )
    expect(errors).toEqual([])
    expect(servers).toHaveLength(1)
    expect(servers[0]).toEqual({
      type: 'stdio',
      name: 'x',
      command: 'node',
      args: ['server.js']
    })
    expect(JSON.stringify(servers[0])).not.toContain('directTools')
    expect(JSON.stringify(servers[0])).not.toContain('alwaysAllow')
  })

  it('passes an env that is already a name/value array through unchanged', () => {
    const { servers, errors } = parseMcpJsonImport(
      JSON.stringify({
        mcpServers: {
          a: { command: 'node', env: [{ name: 'K', value: 'v' }] }
        }
      })
    )
    expect(errors).toEqual([])
    expect(servers[0].env).toEqual([{ name: 'K', value: 'v' }])
  })

  it('parses multiple wrapper servers, each named by its key', () => {
    const { servers, errors } = parseMcpJsonImport(
      JSON.stringify({
        mcpServers: {
          a: { command: 'node', args: ['a.js'] },
          b: { command: 'python', args: ['b.py'] }
        }
      })
    )
    expect(errors).toEqual([])
    expect(servers.map((server) => server.name)).toEqual(['a', 'b'])
    expect(servers[0].command).toBe('node')
    expect(servers[1].command).toBe('python')
  })

  it('infers http when only a url is present', () => {
    const { servers, errors } = parseMcpJsonImport(
      JSON.stringify({
        mcpServers: {
          remote: { url: 'https://mcp.test/mcp' }
        }
      })
    )
    expect(errors).toEqual([])
    expect(servers[0]).toEqual({ type: 'http', name: 'remote', url: 'https://mcp.test/mcp' })
  })

  it('honors an explicit sse type', () => {
    const { servers, errors } = parseMcpJsonImport(
      JSON.stringify({
        mcpServers: {
          legacy: { type: 'sse', url: 'https://mcp.test/sse' }
        }
      })
    )
    expect(errors).toEqual([])
    expect(servers[0]).toEqual({ type: 'sse', name: 'legacy', url: 'https://mcp.test/sse' })
  })

  it('rejects a server with an env in an unknown shape but keeps the rest', () => {
    const { servers, errors } = parseMcpJsonImport(
      JSON.stringify({
        mcpServers: {
          bad: { command: 'node', env: 'KEY=value' },
          good: { command: 'node' }
        }
      })
    )
    expect(servers.map((server) => server.name)).toEqual(['good'])
    expect(errors).toEqual(['bad: env must be an object map or name/value pairs'])
  })

  it('returns an Invalid JSON error for truncated input', () => {
    const { servers, errors } = parseMcpJsonImport('{"mcpServers":{')
    expect(servers).toEqual([])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^Invalid JSON: /)
  })

  it('rejects a server missing a required field with a per-server error', () => {
    const { servers, errors } = parseMcpJsonImport(
      JSON.stringify({
        mcpServers: {
          x: { args: ['-y'] }
        }
      })
    )
    expect(servers).toEqual([])
    expect(errors).toEqual(['x: Command is required for stdio.'])
  })

  it('rejects a top-level mcpServers that is not an object', () => {
    const { servers, errors } = parseMcpJsonImport('{"mcpServers": []}')
    expect(servers).toEqual([])
    expect(errors).toEqual(['Invalid JSON: "mcpServers" must be an object'])
  })
})
