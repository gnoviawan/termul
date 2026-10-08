import { SettingsSection } from '@/components/settings/SettingsLayout'
import { availableColors, getColorClasses } from '@/lib/colors'
import { cn } from '@/lib/utils'
import type { ProjectColor } from '@/types/project'

interface ProjectDefaultsSectionProps {
  defaultProjectColor: ProjectColor
  handleDefaultProjectColorChange: (value: ProjectColor) => void
}

export function ProjectDefaultsSection({
  defaultProjectColor,
  handleDefaultProjectColorChange
}: ProjectDefaultsSectionProps): React.JSX.Element {
  return (
    <SettingsSection id="project-defaults">
      <div className="grid grid-cols-1 items-start gap-6 border-b border-border pb-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="w-full pt-1">
          <h2 className="text-lg font-medium text-foreground">New Project Defaults</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Set default options for new projects.
          </p>
        </div>
        <div className="w-full space-y-4 md:w-fit md:justify-self-end">
          <div>
            <label className="block text-sm font-medium text-secondary-foreground mb-2">
              Default Color
            </label>
            <div className="flex gap-2 flex-wrap">
              {availableColors.map((color) => {
                const colors = getColorClasses(color)
                return (
                  <button
                    key={color}
                    onClick={() => handleDefaultProjectColorChange(color)}
                    className={cn(
                      'w-8 h-8 rounded-full transition-all',
                      colors.bg,
                      defaultProjectColor === color
                        ? 'ring-2 ring-offset-2 ring-offset-background ring-current'
                        : 'hover:opacity-80'
                    )}
                    title={color.charAt(0).toUpperCase() + color.slice(1)}
                  />
                )
              })}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              New projects will use this color by default.
            </p>
          </div>
        </div>
      </div>
    </SettingsSection>
  )
}
