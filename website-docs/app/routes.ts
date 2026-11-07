import { index, type RouteConfig, route } from '@react-router/dev/routes'

// Paths are relative to the `/docs/` basename in react-router.config.ts.
export default [
  route('api/search', 'routes/search.ts'),

  // LLM integration:
  route('llms.txt', 'llms/index.ts'),
  route('llms-full.txt', 'llms/full.ts'),
  route('llms.mdx/*', 'llms/mdx.ts'),

  // A splat route does not match the basename root, so the docs home needs an index route.
  index('routes/docs.tsx', { id: 'docs-home' }),
  route('*', 'routes/docs.tsx')
] satisfies RouteConfig
