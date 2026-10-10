import type { GitStashInfo, GitStatusDetail } from '@shared/types/ipc.types'
import type React from 'react'
import { FileItem, RowAction, SectionAction, SectionHeader } from '@/components/git/rows'
import { StashSection } from '@/components/git/StashSection'
import type { GitActions } from '@/components/git/use-git-actions'
import type { GitSelectionSection } from '@/components/git/use-git-selection'
import { Minus, Plus, RotateCcw } from '@/components/icons'
import { ScrollArea } from '@/components/ui/scroll-area'

interface GitChangeListProps {
  variant: 'desktop' | 'mobile'
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
  const isMobile = variant === 'mobile'
  const rowIconSize = isMobile ? 16 : 13
  const fileItemVariant = isMobile ? 'mobile' : undefined
  const rowActionTouch = isMobile ? true : undefined

  return (
    <ScrollArea className="flex-1 w-full">
      <div className={isMobile ? 'p-2 pr-3 space-y-4 w-full' : 'p-2 pr-3 space-y-4 w-[303px]'}>
        {stagedFiles.length > 0 && (
          <div className="space-y-1">
            <SectionHeader
              label="Staged Changes"
              count={stagedFiles.length}
              selectionCount={stagedSelectionCount}
            >
              <SectionAction
                icon={<Minus size={13} />}
                label="Unstage all changes"
                disabled={isMutating || isGenerating}
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
                    disabled={isMutating || isGenerating}
                    onClick={() => runUnstage(targetsFor(file.path, 'staged'))}
                  />
                </FileItem>
              )
            })}
          </div>
        )}

        <div className="space-y-1">
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
                  disabled={isMutating || isGenerating}
                  onClick={() => requestDiscard(unstagedFiles.map((f) => f.path))}
                />
                <SectionAction
                  icon={<Plus size={13} />}
                  label="Stage all changes"
                  disabled={isMutating || isGenerating}
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
                    disabled={isMutating || isGenerating}
                    onClick={() => requestDiscard(targetsFor(file.path, 'unstaged'))}
                  />
                  <RowAction
                    icon={<Plus size={rowIconSize} />}
                    label="Stage changes"
                    touch={rowActionTouch}
                    disabled={isMutating || isGenerating}
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
    </ScrollArea>
  )
}
