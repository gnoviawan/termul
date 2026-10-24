import { PANEL_FIELD_CLASS } from '@/components/ui/panel-styles'
import { cn } from '@/lib/utils'

/** A text field sized like `SettingsSelect`: full width when narrow, 15rem in a row. */
export const SETTINGS_FIELD_CLASS = cn(PANEL_FIELD_CLASS, 'h-8 w-full px-2.5 @[35rem]:w-60')
