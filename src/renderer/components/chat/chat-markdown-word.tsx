import { type ComponentPropsWithoutRef, type CSSProperties, useRef } from 'react'
import type { ExtraProps } from 'streamdown'

type WordSpanProps = ComponentPropsWithoutRef<'span'> & ExtraProps

/**
 * Renders Streamdown's `span` elements. While a reply streams, Streamdown wraps
 * each word in `span[data-sd-animate]` and re-renders the whole tail on every
 * commit. On that re-render it rewrites the style of every word it has already
 * seen to `--sd-duration: 0ms` with no delay, which finishes a fade that is
 * still waiting or running and pops the word in. The commits come ~10 times a
 * second, so no word ever got more than one commit window of its fade.
 *
 * An animated word keeps the style it mounted with, so its delay and duration
 * play out as scheduled. Other spans follow their latest style.
 */
export function ChatMarkdownSpan({
  node: _node,
  style,
  ...rest
}: WordSpanProps): React.JSX.Element {
  const mountStyle = useRef<CSSProperties | undefined>(style)
  const animatedWord = rest['data-sd-animate' as keyof typeof rest] !== undefined
  return <span {...rest} style={animatedWord ? mountStyle.current : style} />
}
