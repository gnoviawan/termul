import { Loader2 } from 'lucide-react'
import type * as React from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

function Spinner({
  className,
  decorative = false,
  ...props
}: React.ComponentProps<'svg'> & {
  /** Hide from the accessibility tree (e.g. chip trailing affordance with aria-busy). */
  decorative?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('common')
  if (decorative) {
    return (
      <Loader2 aria-hidden="true" className={cn('size-4 animate-spin', className)} {...props} />
    )
  }
  return (
    <Loader2
      role="status"
      aria-label={t('loading')}
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  )
}

export { Spinner }
