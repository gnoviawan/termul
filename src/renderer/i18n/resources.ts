import agentsEn from '@/locales/en/agents.json'
import browserEn from '@/locales/en/browser.json'
import chatEn from '@/locales/en/chat.json'
import commonEn from '@/locales/en/common.json'
import gitEn from '@/locales/en/git.json'
import mcpEn from '@/locales/en/mcp.json'
import mobileEn from '@/locales/en/mobile.json'
import projectsEn from '@/locales/en/projects.json'
import settingsEn from '@/locales/en/settings.json'
import shellEn from '@/locales/en/shell.json'
import sshEn from '@/locales/en/ssh.json'
import terminalEn from '@/locales/en/terminal.json'
import workspaceEn from '@/locales/en/workspace.json'
import agentsZhCn from '@/locales/zh-CN/agents.json'
import browserZhCn from '@/locales/zh-CN/browser.json'
import chatZhCn from '@/locales/zh-CN/chat.json'
import commonZhCn from '@/locales/zh-CN/common.json'
import gitZhCn from '@/locales/zh-CN/git.json'
import mcpZhCn from '@/locales/zh-CN/mcp.json'
import mobileZhCn from '@/locales/zh-CN/mobile.json'
import projectsZhCn from '@/locales/zh-CN/projects.json'
import settingsZhCn from '@/locales/zh-CN/settings.json'
import shellZhCn from '@/locales/zh-CN/shell.json'
import sshZhCn from '@/locales/zh-CN/ssh.json'
import terminalZhCn from '@/locales/zh-CN/terminal.json'
import workspaceZhCn from '@/locales/zh-CN/workspace.json'

export const defaultNS = 'common'

export const resources = {
  en: {
    common: commonEn,
    shell: shellEn,
    settings: settingsEn,
    projects: projectsEn,
    workspace: workspaceEn,
    terminal: terminalEn,
    git: gitEn,
    agents: agentsEn,
    chat: chatEn,
    mcp: mcpEn,
    ssh: sshEn,
    browser: browserEn,
    mobile: mobileEn
  },
  'zh-CN': {
    common: commonZhCn,
    shell: shellZhCn,
    settings: settingsZhCn,
    projects: projectsZhCn,
    workspace: workspaceZhCn,
    terminal: terminalZhCn,
    git: gitZhCn,
    agents: agentsZhCn,
    chat: chatZhCn,
    mcp: mcpZhCn,
    ssh: sshZhCn,
    browser: browserZhCn,
    mobile: mobileZhCn
  }
} as const

export type Namespace = keyof typeof resources.en
export const namespaces = Object.keys(resources.en) as Namespace[]
