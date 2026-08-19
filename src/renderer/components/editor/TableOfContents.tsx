import { List, Settings2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { TocHeading } from '@/hooks/use-toc-headings'
import { cn } from '@/lib/utils'

const HEADING_LEVEL_OPTIONS = [1, 2, 3, 4, 5, 6]

interface TableOfContentsProps {
  headings: TocHeading[]
  activeHeadingId?: string
  maxHeadingLevel: number
  onHeadingClick: (heading: TocHeading) => void
  onMaxHeadingLevelChange: (level: number) => void
}

export function TableOfContents({
  headings,
  activeHeadingId,
  maxHeadingLevel,
  onHeadingClick,
  onMaxHeadingLevelChange
}: TableOfContentsProps): React.JSX.Element {
  const { t } = useTranslation('workspace')
  return (
    <div className="flex h-full min-h-0 flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <List className="h-4 w-4" />
          <span>{t('toc.contents')}</span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title={t('toc.settings')}
              aria-label={t('toc.settings')}
            >
              <Settings2 className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={String(maxHeadingLevel)}
              onValueChange={(value) => onMaxHeadingLevelChange(Number(value))}
            >
              {HEADING_LEVEL_OPTIONS.map((level) => (
                <DropdownMenuRadioItem key={level} value={String(level)}>
                  {`H1-H${level}`}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {headings.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground">
          {t('toc.empty')}
        </div>
      ) : (
        <nav className="flex-1 overflow-auto py-2" aria-label={t('toc.aria')}>
          <ul className="space-y-1 px-2">
            {headings.map((heading) => {
              const isActive = heading.id === activeHeadingId

              return (
                <li key={heading.id}>
                  <button
                    type="button"
                    className={cn(
                      'w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
                      isActive && 'bg-accent text-accent-foreground'
                    )}
                    style={{ paddingLeft: (heading.level - 1) * 12 + 8 }}
                    onClick={() => onHeadingClick(heading)}
                    title={heading.text}
                    aria-current={isActive ? 'location' : undefined}
                  >
                    <span className="block truncate">{heading.text}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
      )}
    </div>
  )
}
