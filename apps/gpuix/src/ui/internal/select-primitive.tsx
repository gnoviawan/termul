/**
 * `@radix-ui/react-select` for shared code that builds its own items from the
 * primitive (`components/settings/SettingsSelect.tsx`): the GPUIX select's
 * parts under Radix's names, so a closed select paints only its trigger.
 */
import type { ReactNode } from 'react'

export {
  Select as Root,
  SelectContent as Content,
  SelectGroup as Group,
  SelectItem as Item,
  SelectItemIndicator as ItemIndicator,
  SelectItemText as ItemText,
  SelectLabel as Label,
  SelectScrollDownButton as ScrollDownButton,
  SelectScrollUpButton as ScrollUpButton,
  SelectSeparator as Separator,
  SelectTrigger as Trigger,
  SelectValue as Value
} from '../select'

const Through = ({ children }: { children?: ReactNode }) => <>{children}</>
export { Through as Icon, Through as Portal, Through as Viewport }
