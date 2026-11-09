import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { DEMO_WORKSPACE_ROOT } from '../demo-server'
import type { Shot } from '../shot'
import { openApp } from '../ui'

const shopRoot = join(DEMO_WORKSPACE_ROOT, 'acme-shop')
const mcpServerPath = join(DEMO_WORKSPACE_ROOT, 'tools', 'issues-mcp.ts')

// A tiny stdio MCP server, so the MCP list can show a reachable server and its tools.
const mcpServerSource = `const tools = [
  { name: 'list_issues', description: 'List open issues for this repo', inputSchema: { type: 'object' } },
  { name: 'create_issue', description: 'Open a new issue', inputSchema: { type: 'object' } }
]
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newline = buffer.indexOf('\\n')
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf('\\n')
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.id === undefined) continue
    const result =
      msg.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'issues', version: '1.0.0' } }
        : msg.method === 'tools/list'
          ? { tools }
          : {}
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
  }
})
`

const skills: Record<string, string> = {
  'review-checklist': `---
name: review-checklist
description: Review a diff against the Acme Shop checklist before you open a PR.
---

# Review checklist

1. Run \`bun test\`.
2. Check that every price uses cents, not floats.
`,
  'release-notes': `---
name: release-notes
description: Write release notes from the commits since the last tag.
---

# Release notes

Group commits by feature, fix and chore.
`
}

async function writeFixture(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
}

async function openSettings(page: Page, category: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click()
  const nav = page.getByRole('navigation', { name: 'Settings categories' })
  await nav.getByRole('button', { name: category, exact: true }).click()
  await page.waitForTimeout(800)
  return page.getByRole('dialog').first()
}

async function openNewChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New chat', exact: true }).first().click()
  await page.locator('[data-composer-editor="true"][aria-label="Agent prompt"]').first().waitFor()
  await page.waitForTimeout(800)
}

async function openAgentPicker(page: Page): Promise<Locator> {
  await page.getByTestId('agent-model-selector-trigger').first().click()
  const search = page.getByRole('textbox', { name: 'Search models and agents' })
  await search.waitFor()
  return search
}

const zedAgentJson = `{
  "agent_servers": {
    "Team Agent": {
      "type": "custom",
      "command": "node",
      "args": ["/opt/team-agent/dist/acp.js"],
      "env": { "TEAM_API_KEY": "$TEAM_API_KEY" }
    }
  }
}`

const mcpJson = `{
  "mcpServers": {
    "issues": { "command": "bun", "args": ["${mcpServerPath}"] },
    "docs": { "type": "http", "url": "http://127.0.0.1:9/mcp" },
    "metrics": { "type": "sse", "url": "https://metrics.example.com/sse" }
  }
}`

async function addMcpServers(page: Page): Promise<void> {
  await writeFixture(mcpServerPath, mcpServerSource)
  await openApp(page)
  await openSettings(page, 'MCP Servers')
  await page.getByRole('button', { name: 'Add server' }).click()
  await page.getByRole('button', { name: 'Import JSON instead' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add MCP servers' })
  await dialog.locator('textarea').fill(mcpJson)
}

async function writeSkills(): Promise<void> {
  for (const [name, body] of Object.entries(skills)) {
    await writeFixture(join(shopRoot, '.agents', 'skills', name, 'SKILL.md'), body)
  }
}

export const shots: Shot[] = [
  {
    id: 'agent-setup-timeouts',
    run: async (page) => {
      await openApp(page)
      await openSettings(page, 'AI Agents')
      await page.waitForTimeout(1500)
    }
  },
  {
    id: 'agent-setup-agents-list',
    run: async (page) => {
      await openApp(page)
      await openSettings(page, 'AI Agents')
      await page.waitForTimeout(1500)
      return page.getByRole('button', { name: 'Check for updates' }).locator('xpath=../..')
    }
  },
  {
    id: 'agent-setup-agent-picker',
    run: async (page) => {
      await openApp(page)
      await openNewChat(page)
      const search = await openAgentPicker(page)
      await page.getByRole('tab', { name: 'More agents' }).first().click()
      await page.waitForTimeout(1000)
      return search.locator('xpath=../..')
    }
  },
  {
    id: 'agent-setup-install-required',
    run: async (page) => {
      await openApp(page)
      await openNewChat(page)
      const search = await openAgentPicker(page)
      await search.fill('amp')
      await page.getByText('Amp', { exact: true }).first().click()
      await page.getByText('Amp is not installed').waitFor()
      await page.keyboard.press('Escape')
      await page.waitForTimeout(1500)
    }
  },
  {
    id: 'agent-setup-custom-agent',
    run: async (page) => {
      await openApp(page)
      await openSettings(page, 'AI Agents')
      await page.getByRole('button', { name: 'Add Custom Agent' }).click()
      const dialog = page.getByRole('dialog', { name: 'Add Custom ACP Agent' })
      await dialog.locator('textarea').fill(zedAgentJson)
      return dialog
    }
  },
  {
    id: 'agent-setup-custom-agent-confirm',
    run: async (page) => {
      await openApp(page)
      await openSettings(page, 'AI Agents')
      await page.getByRole('button', { name: 'Add Custom Agent' }).click()
      const dialog = page.getByRole('dialog', { name: 'Add Custom ACP Agent' })
      await dialog.locator('textarea').fill(zedAgentJson)
      await dialog.getByRole('button', { name: 'Save Agent' }).click()
      const confirm = page.getByRole('dialog', { name: 'Confirm arbitrary command' })
      await confirm.waitFor()
      return confirm
    }
  },
  {
    id: 'agent-setup-provider',
    run: async (page) => {
      await openApp(page)
      await openSettings(page, 'Provider')
      await page.waitForTimeout(1500)
      return page.locator('#settings-section-provider')
    }
  },
  {
    id: 'agent-setup-project-provider',
    run: async (page) => {
      await openApp(page)
      await page
        .getByRole('button', { name: 'Settings for acme-shop' })
        .first()
        .click({ force: true })
      const nav = page.getByRole('navigation', { name: 'Settings categories' })
      await nav.getByRole('button', { name: 'Provider', exact: true }).click()
      await page.waitForTimeout(1500)
      return page.getByRole('dialog').first()
    }
  },
  {
    id: 'agent-setup-mcp-add',
    run: async (page) => {
      await addMcpServers(page)
      return page.getByRole('dialog', { name: 'Add MCP servers' })
    }
  },
  {
    id: 'agent-setup-mcp-list',
    run: async (page) => {
      await addMcpServers(page)
      await page
        .getByRole('dialog', { name: 'Add MCP servers' })
        .getByRole('button', { name: 'Save' })
        .click()
      await page.getByRole('button', { name: 'Test issues connection' }).click()
      await page.getByRole('button', { name: 'Test docs connection' }).click()
      await page.getByRole('img', { name: 'issues reachable' }).waitFor()
      await page.getByRole('img', { name: 'docs unreachable' }).waitFor()
      await page.getByText('2 tools').click()
      await page.getByText('list_issues').waitFor()
      await page.waitForTimeout(800)
      return page.locator('#settings-section-mcp-servers')
    }
  },
  {
    id: 'agent-setup-skills',
    run: async (page) => {
      await writeSkills()
      await openApp(page)
      await openSettings(page, 'Skills')
      return page.getByRole('heading', { name: 'Project · acme-shop' }).locator('xpath=..')
    }
  },
  {
    id: 'agent-setup-slash-skills',
    run: async (page) => {
      await writeSkills()
      await openApp(page)
      await openNewChat(page)
      await page.locator('[data-composer-editor="true"][aria-label="Agent prompt"]').first().click()
      await page.keyboard.type('/rev')
      await page.waitForTimeout(1200)
    }
  },
  {
    id: 'agent-setup-launch-agent',
    run: async (page) => {
      await openApp(page)
      await page.keyboard.press('Control+k')
      const search = page.getByPlaceholder('Search commands, projects, settings...')
      await search.fill('launch agent')
      await page.waitForTimeout(800)
    }
  }
]
