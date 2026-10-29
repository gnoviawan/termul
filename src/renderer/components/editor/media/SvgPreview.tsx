import { useEffect, useState } from 'react'
import { basename } from '@/lib/path-basename'
import { CHECKERBOARD_CLASS } from './viewer-chrome'

/**
 * The live SVG buffer rendered as an `<img>` from a `blob:` URL. An `<img>`
 * never runs the SVG's scripts or loads its external resources, unlike
 * inlining the markup.
 */
export function SvgPreview({
  filePath,
  content
}: {
  filePath: string
  content: string
}): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([content], { type: 'image/svg+xml' }))
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [content])

  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-auto bg-background p-4">
      {url && (
        <img
          src={url}
          alt={basename(filePath)}
          draggable={false}
          className={`max-h-full max-w-full ${CHECKERBOARD_CLASS}`}
        />
      )}
    </div>
  )
}
