/**
 * The project registry stores Windows roots in verbatim form (`\\?\D:\proj`,
 * `\\?\UNC\srv\share`), and the desktop explorer spells them `//?/D:/proj`.
 * Drop the prefix and keep the separators the path came with. Shell APIs such
 * as `ILCreateFromPathW` reject verbatim paths, and a `/` inside one names a
 * different file.
 */
export function stripVerbatimPrefix(path: string): string {
  return path
    .replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, (prefix) => prefix.slice(0, 2))
    .replace(/^[\\/]{2}\?[\\/]/, '')
}
