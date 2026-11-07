import { useEffect, useMemo, useState } from 'react'
import { logFrontendError } from '@/lib/log-api'
import { readMediaBytes } from '@/lib/media-bytes-api'
import { basename } from '@/lib/path-basename'
import {
  openPdfDocument,
  type PdfDocument,
  type PdfLoad,
  type PdfOpenFailure
} from './pdf-document'

export type PdfFailure =
  | { kind: 'read'; code: string }
  | { kind: 'too-large' }
  | { kind: PdfOpenFailure }

export type PdfDocumentState =
  | { status: 'loading' }
  | { status: 'ready'; doc: PdfDocument }
  | { status: 'error'; failure: PdfFailure }

export function usePdfDocument(filePath: string, revision: number): PdfDocumentState {
  const [state, setState] = useState<PdfDocumentState>({ status: 'loading' })

  const shownDoc = state.status === 'ready' ? state.doc : null
  useEffect(() => () => shownDoc?.destroy(), [shownDoc])

  const request = useMemo(() => ({ filePath, revision }), [filePath, revision])
  useEffect(() => {
    const { filePath } = request
    let stale = false
    let pending: PdfLoad | null = null
    let adopted = false

    void (async () => {
      const read = await readMediaBytes(filePath)
      if (stale) return
      if (!read.success) {
        setState({
          status: 'error',
          failure:
            read.code === 'FILE_TOO_LARGE'
              ? { kind: 'too-large' }
              : { kind: 'read', code: read.code }
        })
        return
      }
      pending = openPdfDocument(read.data)
      if (stale) {
        pending.destroy()
        return
      }
      const result = await pending.result
      if (stale) return
      if (!result.ok) {
        pending.destroy()
        void logFrontendError({
          level: 'warn',
          source: 'pdfViewer.open',
          message: `Failed to open PDF '${basename(filePath)}' (${result.errorName})`
        })
        setState({ status: 'error', failure: { kind: result.failure } })
        return
      }
      adopted = true
      setState({ status: 'ready', doc: result.doc })
    })()

    return () => {
      stale = true
      if (!adopted) pending?.destroy()
    }
  }, [request])

  return state
}
