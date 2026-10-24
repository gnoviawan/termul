/**
 * GPUIX twin of `pages/app-preferences/use-server-version.ts`. This client is
 * not served by the termul-server, so its own build version says nothing
 * about the server's. The server reports its build version in the
 * diagnostics bundle (`POST /log/diagnostics`, `appVersion`), fetched once
 * per window; until it answers, and if it cannot, the row reads "version
 * unknown" rather than this client's version.
 */

import { useEffect, useState } from 'react'
import { bugReportApi } from '@/lib/bug-report-api'
import { log } from '../../../log'

let cached: Promise<string | null> | null = null

function fetchServerVersion(): Promise<string | null> {
  cached ??= bugReportApi.collectBugReportContext().then((result) => {
    if (result.success && result.data.appVersion) return `v${result.data.appVersion}`
    log.warn(
      'server-version',
      `diagnostics did not report a version (code=${result.success ? 'empty' : result.code})`
    )
    cached = null
    return null
  })
  return cached
}

export function useServerVersion(): string {
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void fetchServerVersion().then((next) => {
      if (live) setVersion(next)
    })
    return () => {
      live = false
    }
  }, [])
  return version ?? 'version unknown'
}
