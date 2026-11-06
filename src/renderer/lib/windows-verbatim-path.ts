/**
 * The project registry stores Windows roots in verbatim form (`\\?\D:\proj`,
 * `\\?\UNC\srv\share`), and the desktop explorer spells them `//?/D:/proj`.
 * Drop the prefix from drive and UNC paths and keep the separators the path
 * came with. Shell APIs such as `ILCreateFromPathW` reject verbatim paths, and
 * a `/` inside one names a different file. Any other verbatim path
 * (`\\?\Volume{…}\`) has no plain spelling, and on macOS or Linux `//?/x` is
 * an ordinary path, so those stay as they are.
 */
export function stripVerbatimPrefix(path: string): string {
  return path
    .replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, (prefix) => prefix.slice(0, 2))
    .replace(/^[\\/]{2}\?[\\/](?=[A-Za-z]:)/, '')
}

/**
 * `path` in the form the OS shell opens. Windows trims a trailing `.` or space
 * from every component of a plain path, so a name like `notes.` is reachable
 * only through the verbatim form: such a path keeps its prefix.
 */
export function shellPath(path: string): string {
  const stripped = stripVerbatimPrefix(path)
  return /[. ](?:[\\/]|$)/.test(stripped) && stripped !== path ? path : stripped
}
