import { Folder, GitBranch } from '@/components/icons'

interface CommandChipsProps {
  cwd?: string
  gitBranch?: string
}

export function CommandChips({ cwd, gitBranch }: CommandChipsProps) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground">
      {cwd && (
        <span
          role="note"
          aria-label="Working directory"
          title={cwd}
          className="inline-flex min-w-0 max-w-[60%] items-center gap-1 rounded-md border border-border/60 bg-muted/50 px-2 py-1"
        >
          <Folder size={12} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{cwd}</span>
        </span>
      )}
      {gitBranch && (
        <span
          role="note"
          aria-label="Git branch"
          title={gitBranch}
          className="inline-flex min-w-0 max-w-[40%] items-center gap-1 rounded-md border border-border/60 bg-muted/50 px-2 py-1"
        >
          <GitBranch size={12} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{gitBranch}</span>
        </span>
      )}
    </div>
  )
}
