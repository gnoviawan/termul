import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { appName, docsRoute, gitConfig } from './shared'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
      url: docsRoute
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`
  }
}
