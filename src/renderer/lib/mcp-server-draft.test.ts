import { describe, expect, it } from 'vitest'
import type { StoredMcpServer } from './acp-mcp-persistence'
import {
  blankRow,
  draftFromServer,
  draftToConfig,
  draftToUncheckedConfig,
  emptyDraft,
  joinCommandLine,
  liftEnvPrefix,
  type McpServerDraft,
  tokenizeCommandLine,
  transportForUrl,
  withAuth,
  withUrl
} from './mcp-server-draft'

function localDraft(commandLine: string, env = [blankRow()]): McpServerDraft {
  return { ...emptyDraft(), kind: 'local', name: 'github', local: { commandLine, env } }
}

function remoteDraft(url: string, patch: Partial<McpServerDraft['remote']> = {}): McpServerDraft {
  const draft = emptyDraft()
  return { ...draft, name: 'linear', remote: { ...withUrl(draft.remote, url), ...patch } }
}

describe('tokenizeCommandLine', () => {
  it('splits on runs of whitespace', () => {
    expect(tokenizeCommandLine('  npx   -y\t@dokploy/mcp ')).toEqual(['npx', '-y', '@dokploy/mcp'])
  })

  it('keeps quoted spaces and joins adjacent quoted parts', () => {
    expect(tokenizeCommandLine(`node "my server.js" --root='/a b' ""`)).toEqual([
      'node',
      'my server.js',
      '--root=/a b',
      ''
    ])
  })

  it('keeps backslashes literal so Windows paths work, escaping only \\" and \\\\ in double quotes', () => {
    expect(tokenizeCommandLine(`echo 'a\\"b' "c\\"d\\\\e\\n" C:\\tools\\x.exe`)).toEqual([
      'echo',
      'a\\"b',
      'c"d\\e\\n',
      'C:\\tools\\x.exe'
    ])
  })

  it('reads a backslash before a space or quote outside quotes as an escape', () => {
    expect(
      tokenizeCommandLine(`node /home/alice/My\\ Tools/server.js it\\'s C:\\tools\\x.exe`)
    ).toEqual(['node', '/home/alice/My Tools/server.js', "it's", 'C:\\tools\\x.exe'])
  })

  it('returns null for an unclosed quote', () => {
    expect(tokenizeCommandLine('npx "@scope/pkg')).toBeNull()
  })

  it('round-trips through joinCommandLine', () => {
    const tokens = ['C:\\Program Files\\node.exe', "it's", 'a"b\\', '', '-y']
    expect(joinCommandLine(tokens)).toBe(`'C:\\Program Files\\node.exe' "it's" 'a"b\\' '' -y`)
    expect(tokenizeCommandLine(joinCommandLine(tokens))).toEqual(tokens)
  })
})

describe('liftEnvPrefix', () => {
  it('moves leading NAME=value words into env rows and keeps the rest verbatim', () => {
    const local = liftEnvPrefix({
      commandLine: `GITHUB_TOKEN=abc LABEL="two words" npx -y "@scope/pkg" X=1`,
      env: [blankRow(), blankRow('GITHUB_TOKEN', 'old'), blankRow('DEBUG', '1')]
    })
    expect(local.commandLine).toBe('npx -y "@scope/pkg" X=1')
    expect(local.env.map(({ name, value }) => [name, value])).toEqual([
      ['GITHUB_TOKEN', 'abc'],
      ['DEBUG', '1'],
      ['LABEL', 'two words']
    ])
  })

  it('leaves a line without an env prefix alone', () => {
    const local = { commandLine: 'uvx mcp-server-git', env: [blankRow()] }
    expect(liftEnvPrefix(local)).toBe(local)
  })
})

describe('transportForUrl', () => {
  it.each([
    ['https://mcp.asana.com/sse', 'sse'],
    ['https://mcp.example.com/sse/?session=1', 'sse'],
    ['https://mcp.linear.app/mcp', 'http'],
    ['https://example.com/sse-tools', 'http'],
    ['mcp.example.com/sse', 'sse'],
    ['', 'http']
  ] as const)('%s → %s', (url, transport) => {
    expect(transportForUrl(url)).toBe(transport)
  })

  it('follows the URL until the connection type is picked by hand', () => {
    const followed = withUrl(emptyDraft().remote, 'https://mcp.asana.com/sse')
    expect(followed.transport).toBe('sse')
    const pinned = withUrl(
      { ...followed, transport: 'http', transportPinned: true },
      'https://x.test/sse'
    )
    expect(pinned).toMatchObject({ url: 'https://x.test/sse', transport: 'http' })
  })
})

describe('draftToConfig', () => {
  it('builds a stdio config from the command line and env rows', () => {
    const draft = localDraft('DOKPLOY_URL=https://dokploy.test npx -y @dokploy/mcp', [
      blankRow('DOKPLOY_API_KEY', '$DOKPLOY_API_KEY'),
      blankRow()
    ])
    expect(draftToConfig({ ...draft, name: ' dokploy ' })).toEqual({
      config: {
        type: 'stdio',
        name: 'dokploy',
        command: 'npx',
        args: ['-y', '@dokploy/mcp'],
        env: [
          { name: 'DOKPLOY_API_KEY', value: '$DOKPLOY_API_KEY' },
          { name: 'DOKPLOY_URL', value: 'https://dokploy.test' }
        ]
      }
    })
  })

  it('saves env values with their surrounding spaces', () => {
    const draft = localDraft('my-server', [blankRow(' PADDED ', ' two words ')])
    expect(draftToConfig(draft)).toEqual({
      config: {
        type: 'stdio',
        name: 'github',
        command: 'my-server',
        env: [{ name: 'PADDED', value: ' two words ' }]
      }
    })
  })

  it('omits empty args and env', () => {
    expect(draftToConfig(localDraft('my-server'))).toEqual({
      config: { type: 'stdio', name: 'github', command: 'my-server' }
    })
  })

  it('builds an http config with the token header', () => {
    const draft = remoteDraft('https://mcp.linear.app/mcp')
    const remote = withAuth(draft.remote, 'token')
    const filled = remote.headers.map((row) =>
      row.name === 'Authorization' ? { ...row, value: 'Bearer $LINEAR_KEY' } : row
    )
    expect(draftToConfig({ ...draft, remote: { ...remote, headers: filled } })).toEqual({
      config: {
        type: 'http',
        name: 'linear',
        url: 'https://mcp.linear.app/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer $LINEAR_KEY' }]
      }
    })
  })

  it('builds an sse config from an /sse URL', () => {
    expect(draftToConfig(remoteDraft(' https://mcp.asana.com/sse '))).toEqual({
      config: { type: 'sse', name: 'linear', url: 'https://mcp.asana.com/sse' }
    })
  })

  it('flags a named row without a value and ignores fully empty rows', () => {
    const draft = localDraft('npx -y pkg', [blankRow(), blankRow('API_KEY', '  ')])
    expect(draftToConfig(draft)).toEqual({ errors: { env: 'Needs a value.' } })
    const remote = remoteDraft('https://x.test/mcp', { headers: [blankRow('', 'orphan')] })
    expect(draftToConfig(remote)).toEqual({ errors: { headers: 'Needs a name.' } })
  })

  it('maps validator issues onto form fields', () => {
    expect(draftToConfig({ ...remoteDraft('not a url'), name: '' })).toEqual({
      errors: {
        name: 'Give the server a name.',
        url: 'Enter a full URL, like https://mcp.example.com/mcp.'
      }
    })
    expect(draftToConfig(remoteDraft(''))).toEqual({ errors: { url: 'Enter the server URL.' } })
    expect(draftToConfig(localDraft('FOO=1'))).toEqual({
      errors: { commandLine: 'Enter the command that starts the server.' }
    })
    expect(draftToConfig(localDraft('npx "oops'))).toEqual({
      errors: { commandLine: 'Close the quote in the command.' }
    })
  })
})

describe('withAuth', () => {
  it('adds an empty Authorization row for token sign-in and removes it for browser sign-in', () => {
    const draft = remoteDraft('https://x.test/mcp', {
      headers: [blankRow(), blankRow('X-Team', 'core')]
    })
    const token = withAuth(draft.remote, 'token')
    expect(token.headers.map(({ name, value }) => [name, value])).toEqual([
      ['Authorization', ''],
      ['X-Team', 'core']
    ])
    expect(draftToConfig({ ...draft, remote: token })).toEqual({
      errors: { headers: 'Needs a value.' }
    })
    const browser = withAuth(token, 'browser')
    expect(browser.headers.map(({ name, value }) => [name, value])).toEqual([['X-Team', 'core']])
    expect(browser.auth).toBe('browser')
  })
})

describe('draftFromServer', () => {
  const servers: StoredMcpServer[] = [
    {
      id: 'a',
      type: 'stdio',
      name: 'files',
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['server.js', '--root', '/srv/my files'],
      env: [{ name: 'TOKEN', value: '$TOKEN' }],
      enabled: false
    },
    {
      id: 'b',
      type: 'http',
      name: 'linear',
      url: 'https://mcp.linear.app/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer $KEY' }],
      enabled: true
    },
    { id: 'c', type: 'sse', name: 'legacy', url: 'https://legacy.test/events', enabled: true }
  ]

  it.each(servers)('round-trips $name back to the same config', (server) => {
    const { id: _id, enabled: _enabled, catalog: _catalog, ...config } = server
    expect(draftToConfig(draftFromServer(server))).toEqual({ config })
  })

  it('pins a transport the URL would not pick and reads the sign-in mode from headers', () => {
    const [, linear, legacy] = servers
    expect(draftFromServer(legacy as StoredMcpServer).remote).toMatchObject({
      transport: 'sse',
      transportPinned: true,
      auth: 'browser'
    })
    expect(draftFromServer(linear as StoredMcpServer).remote).toMatchObject({
      transport: 'http',
      transportPinned: false,
      auth: 'token'
    })
  })
})

describe('draftToUncheckedConfig', () => {
  it('closes an open quote and keeps named rows without a value', () => {
    const draft = localDraft('npx "@scope/pkg --flag', [
      blankRow('API_KEY', ''),
      blankRow('', 'orphan')
    ])
    expect(draftToUncheckedConfig(draft)).toEqual({
      type: 'stdio',
      name: 'github',
      command: 'npx',
      args: ['@scope/pkg --flag'],
      env: [{ name: 'API_KEY', value: '' }]
    })
  })
})
