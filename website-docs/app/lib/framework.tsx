import { FrameworkProvider } from 'fumadocs-core/framework'
import { type ComponentProps, type ReactNode, useMemo } from 'react'
import { Link, useLocation, useNavigate, useParams, useRevalidator } from 'react-router'
import { docsRoute } from './shared'

// Fumadocs page URLs, MDX links and the search index use site paths such as
// `/docs/agents`, while React Router works below its `/docs/` basename. This
// adapter translates between the two so every docs link keeps one spelling.
function toRouterPath(href: string): string | undefined {
  if (href === docsRoute) return '/'
  if (
    href.startsWith(`${docsRoute}/`) ||
    href.startsWith(`${docsRoute}#`) ||
    href.startsWith(`${docsRoute}?`)
  ) {
    return href.slice(docsRoute.length) || '/'
  }
  return undefined
}

function useDocsParams() {
  const params = useParams()
  return useMemo(
    () =>
      Object.fromEntries(
        Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
    [params]
  )
}

function usePathname() {
  const { pathname } = useLocation()
  return pathname === '/' ? docsRoute : `${docsRoute}${pathname}`
}

function useRouter() {
  const navigate = useNavigate()
  const revalidator = useRevalidator()
  return useMemo(
    () => ({
      push(url: string) {
        const to = toRouterPath(url)
        if (to === undefined) window.location.assign(url)
        else navigate(to)
      },
      refresh() {
        revalidator.revalidate()
      }
    }),
    [navigate, revalidator]
  )
}

function DocsLink({ href = '', prefetch, ...props }: ComponentProps<'a'> & { prefetch?: boolean }) {
  const to = toRouterPath(href)
  if (to === undefined) return <a href={href} {...props} />
  return <Link to={to} prefetch={prefetch ? 'intent' : 'none'} {...props} />
}

export function DocsFrameworkProvider({ children }: { children: ReactNode }) {
  return (
    <FrameworkProvider
      usePathname={usePathname}
      useParams={useDocsParams}
      useRouter={useRouter}
      Link={DocsLink}
    >
      {children}
    </FrameworkProvider>
  )
}
