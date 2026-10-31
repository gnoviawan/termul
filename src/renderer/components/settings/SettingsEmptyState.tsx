interface SettingsEmptyStateProps {
  icon: React.ReactNode
  title: string
  /** One line on what the list is for. */
  description: string
  /** The button that adds the first item. */
  action?: React.ReactNode
}

/** Stands in for an empty settings list: what goes here, and how to add one. */
export function SettingsEmptyState({
  icon,
  title,
  description,
  action
}: SettingsEmptyStateProps): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-card px-6 py-8 text-center">
      <span aria-hidden="true" className="mb-1 flex text-muted-foreground">
        {icon}
      </span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      {action && <div className="flex flex-wrap justify-center gap-2 pt-2">{action}</div>}
    </div>
  )
}
