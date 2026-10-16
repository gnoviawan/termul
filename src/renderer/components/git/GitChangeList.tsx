import type { GitStashInfo, GitStatusDetail } from '@shared/types/ipc.types'
import type React from 'react'
import { FileItem, RowAction, SectionAction, SectionHeader } from '@/components/git/rows'
import { StashSection } from '@/components/git/StashSection'
import type { GitActions } from '@/components/git/use-git-actions'
import type { GitSelectionSection } from '@/components/git/use-git-selection'
import { Minus, Plus, RotateCcw } from '@/components/icons'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useServerAdmitsRemoteWrites } from '@/hooks/use-server-admits-remote-writes'
import { cn } from '@/lib/utils'

interface GitChangeListProps {
  /** `column` is the desktop look at full width without its own scroll area:
      the shell Changes panel scrolls the whole upper region instead. */
  variant: 'desktop' | 'mobile' | 'column'
  stagedFiles: GitStatusDetail[]
  unstagedFiles: GitStatusDetail[]
  stashes: GitStashInfo[]
  selectedFile: string | null
  selectedStaged: boolean
  selectionSection: GitSelectionSection | null
  selectedPaths: Set<string>
  stagedSelectionCount: number
  unstagedSelectionCount: number
  isMutating: boolean
  isGenerating: boolean
  onFileClick: (
    e: React.MouseEvent | React.KeyboardEvent,
    path: string,
    staged: boolean,
    sectionFiles: GitStatusDetail[]
  ) => void
  targetsFor: (path: string, section: GitSelectionSection) => string[]
  runStage: GitActions['runStage']
  runUnstage: GitActions['runUnstage']
  requestDiscard: GitActions['requestDiscard']
  onApplyStash: GitActions['handleApplyStash']
  onPopStash: GitActions['handlePopStash']
  onDropStash: GitActions['handleDropStash']
}

/** Staged / Changes sections plus the Stash section, inside the scroll body. */
export function GitChangeList({
  variant,
  stagedFiles,
  unstagedFiles,
  stashes,
  selectedFile,
  selectedStaged,
  selectionSection,
  selectedPaths,
  stagedSelectionCount,
  unstagedSelectionCount,
  isMutating,
  isGenerating,
  onFileClick,
  targetsFor,
  runStage,
  runUnstage,
  requestDiscard,
  onApplyStash,
  onPopStash,
  onDropStash
}: GitChangeListProps) {
  const admitted = useServerAdmitsRemoteWrites()
  const isMobile = variant === 'mobile'
  const rowIconSize = isMobile ? 16 : 13
  const fileItemVariant = isMobile ? 'mobile' : undefined
  const rowActionTouch = isMobile ? true : undefined

  const isColumn = variant === 'column'
  const busy = isMutating || isGenerating

  const body = (
    <div className={cn('space-y-2 px-2 pb-2', variant === 'desktop' ? 'w-[312px]' : 'w-full')}>
      {stagedFiles.length > 0 && (
        <div>
          <SectionHeader
            label="Staged"
            count={stagedFiles.length}
            selectionCount={stagedSelectionCount}
          >
            <SectionAction
              icon={<Minus size={13} />}
              label="Unstage all changes"
              disabled={busy}
              gated={!admitted}
              onClick={() => runUnstage(stagedFiles.map((f) => f.path))}
            />
          </SectionHeader>
          {stagedFiles.map((file: GitStatusDetail) => {
            const inSelection = selectionSection === 'staged' && selectedPaths.has(file.path)
            return (
              <FileItem
                key={file.path}
                file={file}
                variant={fileItemVariant}
                isActive={selectedFile === file.path && selectedStaged}
                isSelected={inSelection}
                onClick={(e) => onFileClick(e, file.path, true, stagedFiles)}
              >
                <RowAction
                  icon={<Minus size={rowIconSize} />}
                  label="Unstage changes"
                  touch={rowActionTouch}
                  disabled={busy}
                  gated={!admitted}
                  onClick={() => runUnstage(targetsFor(file.path, 'staged'))}
                />
              </FileItem>
            )
          })}
        </div>
      )}

      <div>
        <SectionHeader
          label="Changes"
          count={unstagedFiles.length}
          selectionCount={unstagedSelectionCount}
        >
          {unstagedFiles.length > 0 && (
            <>
              <SectionAction
                icon={<RotateCcw size={13} />}
                label="Discard all changes"
                variant="danger"
                disabled={busy}
                gated={!admitted}
                onClick={() => requestDiscard(unstagedFiles.map((f) => f.path))}
              />
              <SectionAction
                icon={<Plus size={13} />}
                label="Stage all changes"
                disabled={busy}
                gated={!admitted}
                onClick={() => runStage(unstagedFiles.map((f) => f.path))}
              />
            </>
          )}
        </SectionHeader>
        {unstagedFiles.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-xs text-muted-foreground">No changes detected</p>
          </div>
        ) : (
          unstagedFiles.map((file: GitStatusDetail) => {
            const inSelection = selectionSection === 'unstaged' && selectedPaths.has(file.path)
            return (
              <FileItem
                key={file.path}
                file={file}
                variant={fileItemVariant}
                isActive={selectedFile === file.path && !selectedStaged}
                isSelected={inSelection}
                onClick={(e) => onFileClick(e, file.path, false, unstagedFiles)}
              >
                <RowAction
                  icon={<RotateCcw size={rowIconSize} />}
                  label="Discard changes"
                  touch={rowActionTouch}
                  variant="danger"
                  disabled={busy}
                  gated={!admitted}
                  onClick={() => requestDiscard(targetsFor(file.path, 'unstaged'))}
                />
                <RowAction
                  icon={<Plus size={rowIconSize} />}
                  label="Stage changes"
                  touch={rowActionTouch}
                  disabled={busy}
                  gated={!admitted}
                  onClick={() => runStage(targetsFor(file.path, 'unstaged'))}
                />
              </FileItem>
            )
          })
        )}
      </div>

      <StashSection
        variant={fileItemVariant}
        stashes={stashes}
        isMutating={isMutating}
        isGenerating={isGenerating}
        onApply={onApplyStash}
        onPop={onPopStash}
        onDrop={onDropStash}
      />
    </div>
  )

  if (isColumn) return body
  return <ScrollArea className="flex-1 w-full">{body}</ScrollArea>
}
