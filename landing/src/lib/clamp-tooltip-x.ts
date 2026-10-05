/** Keep a tooltip's left edge inside the viewport. Wider tips pin to the left margin. */
export function clampTooltipX(
  rawX: number,
  width: number,
  groupLeft: number,
  viewportWidth: number,
  margin = 8,
): number {
  const minX = margin - groupLeft;
  const maxX = viewportWidth - margin - width - groupLeft;
  if (minX > maxX) return minX;
  return Math.min(Math.max(rawX, minX), maxX);
}
