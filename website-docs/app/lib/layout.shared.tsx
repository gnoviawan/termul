import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { Link } from 'react-router'
import { appName, gitConfig } from './shared'

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Link to="/">{appName}</Link>
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`
  }
}
