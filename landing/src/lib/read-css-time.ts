/** Read a millisecond custom property from :root. `150ms` becomes 150. */
export function readCssTime(name: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;

  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const value = parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}
