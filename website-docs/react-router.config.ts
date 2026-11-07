import { glob } from 'node:fs/promises'
import type { Config } from '@react-router/dev/config'
import { getSlugs } from 'fumadocs-core/source'
import { docsRoute } from './app/lib/shared'

export default {
  ssr: false,
  basename: `${docsRoute}/`,
  async prerender({ getStaticPaths }) {
    const paths = getStaticPaths()

    for await (const entry of glob('**/*.mdx', { cwd: 'content/docs' })) {
      const slugs = getSlugs(entry)
      paths.push(`/${slugs.join('/')}`, `/llms.mdx/${[...slugs, 'content.md'].join('/')}`)
    }

    return paths
  }
} satisfies Config
