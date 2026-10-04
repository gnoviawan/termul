import { getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import type { Project } from '@/types/project'

export interface ProjectIconProps {
  project: Project
  /** Square edge in px — the identity glyph sits at 13–18 px across surfaces. */
  size?: number
  className?: string
}

/**
 * Per-project identity glyph (spec-project-icon): renders the resolved icon
 * (`project.icon.dataUri` — a `data:` payload, CSP-safe) as a rounded image,
 * else a colored monogram tile keyed on `project.color` carrying the first
 * letter of `project.name`. Semantic tokens only — `bg-project-*` is the
 * token pair; `text-primary-foreground` is the documented on-fill ink.
 *
 * The tile is decorative inside rows that already carry the project name as
 * accessible text, so it is `aria-hidden`.
 */
export function ProjectIcon({ project, size = 16, className }: ProjectIconProps) {
  const dataUri = project.icon?.dataUri
  if (dataUri) {
    return (
      <img
        src={dataUri}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        className={cn('shrink-0 rounded object-cover', className)}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      data-project-color={project.color}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.62)) }}
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center rounded font-semibold uppercase leading-none text-primary-foreground',
        getColorClasses(project.color).bg,
        className
      )}
    >
      {project.name.charAt(0).toUpperCase() || '?'}
    </span>
  )
}
