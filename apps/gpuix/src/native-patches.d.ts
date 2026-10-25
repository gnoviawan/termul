/**
 * Fields Termul's patched @gpuix/native understands (native/gpuix-native/
 * patches). The published 0.11.0 addon ignores unknown style and theme keys,
 * so setting them is harmless there; they only take effect on the self-built
 * addon (docs/native-patches.md).
 */
import '@gpuix/native/host'

declare module '@gpuix/native/host' {
  interface StyleDesc {
    /** Picks the family's italic face (patch 0001-font-style). Inherited like the rest of the text style. */
    fontStyle?: 'normal' | 'italic'
    /**
     * CSS `backdrop-filter: blur(<px>)` (patch zed/0003 + gpuix/0005): the
     * Gaussian's standard deviation. Blurs what is painted behind the element,
     * inside its rounded box. Not inherited.
     */
    backdropBlur?: number
  }
  interface GpuixTheme {
    /** Markdown link text (patch 0002-markdown-theme). Unset: the text colour. */
    link?: string
    /** Markdown link underline. Unset: `textMuted`. */
    linkUnderline?: string
    /** Markdown link weight. Unset: the paragraph's. */
    linkWeight?: number
    /** Every markdown run italic (a CSS-italic blockquote). */
    fontStyle?: 'normal' | 'italic'
  }
  interface GpuixMetrics {
    /** Inline-code glyph size as a fraction of the paragraph's, like CSS `0.88em`. */
    mdInlineCodeScale?: number
    /** Paint-only reach of the inline-code wash past the glyphs, each side. */
    mdInlineCodePaddingX?: number
    /** Inset of the inline-code wash from the top and bottom of the line box. */
    mdInlineCodeInsetY?: number
  }
}
