/**
 * Termul brand mark.
 *
 * Inline SVG so it can inherit the current text color via `currentColor`,
 * which keeps it legible on both light and dark themes. Source artwork lives
 * at `landing/public/termul.svg` (white fill); this is the theme-aware variant.
 */
export function TermulMark({
  size = 22,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 569 507"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Termul"
      className={className}
      style={{ fillRule: 'evenodd', clipRule: 'evenodd' }}
    >
      <g transform="matrix(1,0,0,1,-446.039965,-826.589138)" fill="currentColor">
        <g transform="matrix(2.924821,0,0,2.924821,37.282287,448.301549)">
          <g transform="matrix(1,0,0,1,-26.278515,0)">
            <path d="M272.622,302.62L251.873,302.62C254.474,302.62 256.699,300.753 257.148,298.192L288.639,157.389L248.668,157.389L216.975,296.321C216.918,296.642 216.89,296.96 216.89,297.273C216.89,296.96 216.918,296.642 216.975,296.321L248.668,157.389L354.887,157.389C358.216,157.389 360.739,160.394 360.163,163.673L353.504,201.53C353.053,204.091 350.829,205.959 348.228,205.959L300.845,205.959L277.898,298.192C277.448,300.753 275.223,302.62 272.622,302.62Z" />
          </g>
          <path d="M146.496,133.765L139.837,171.622C139.261,174.901 141.784,177.907 145.113,177.907L190.062,177.907L167.442,268.284C166.865,271.563 169.388,274.568 172.717,274.568L223.11,274.568C225.71,274.568 227.935,272.701 228.385,270.14L258.769,135.621C259.346,132.342 256.824,129.337 253.494,129.337L151.772,129.337C149.171,129.337 146.947,131.204 146.496,133.765Z" />
        </g>
      </g>
    </svg>
  )
}
