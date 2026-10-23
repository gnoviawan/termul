/** GPUIX's `<anchored>` layer, for the DOM-typed stand-ins that render it. */
import 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      anchored: Record<string, unknown>
    }
  }
}
