import { Fragment, useEffect, useRef } from 'react'
import { ChevronRight } from '@/components/icons'
import { FOCUS_RING_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'

/** `/home/u/app` → `[['/', '/'], ['home', '/home'], ['u', '/home/u'], ['app', '/home/u/app']]` */
export function pathSegments(path: string): Array<[label: string, path: string]> {
  const parts = path.split('/').filter(Boolean)
  return [
    ['/', '/'],
    ...parts.map((part, i): [string, string] => [part, `/${parts.slice(0, i + 1).join('/')}`])
  ]
}

/** The current remote folder; every parent segment opens that folder. */
export function SftpBreadcrumb({
  path,
  onNavigate
}: {
  path: string
  onNavigate: (path: string) => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLOListElement>(null)
  const segments = pathSegments(path)

  // Deep paths overflow: keep the current folder in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll whenever the folder changes
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [path])

  return (
    <nav aria-label="Folder path" title={path} className="shrink-0 border-b border-border">
      <ol
        ref={scrollRef}
        className="scrollbar-hide flex h-7.5 items-center gap-0.5 overflow-x-auto px-2 font-mono text-2xs"
      >
        {segments.map(([label, target], i) => {
          const current = i === segments.length - 1
          return (
            <Fragment key={target}>
              {i > 1 && (
                <li aria-hidden="true" className="flex shrink-0 text-muted-foreground/70">
                  <ChevronRight size={10} />
                </li>
              )}
              <li className="flex shrink-0">
                {current ? (
                  <span
                    className="whitespace-nowrap px-1 font-medium text-foreground"
                    aria-current="page"
                  >
                    {label}
                  </span>
                ) : (
                  <button
                    type="button"
                    className={cn(
                      'whitespace-nowrap rounded px-1 py-0.5 text-muted-foreground transition-colors duration-150 ease-out hover:bg-foreground/[0.06] hover:text-foreground',
                      FOCUS_RING_CLASS
                    )}
                    onClick={() => onNavigate(target)}
                    aria-label={target === '/' ? 'Go to root folder' : `Go to ${target}`}
                  >
                    {label}
                  </button>
                )}
              </li>
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}
