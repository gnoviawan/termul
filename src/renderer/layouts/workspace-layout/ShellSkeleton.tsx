import { Skeleton } from '@/components/ui/skeleton'

/** Lightweight skeleton Suspense fallback for lazy-loaded shell components. */
export function ShellSkeleton(): React.JSX.Element {
  return <Skeleton className="h-full w-full" />
}
