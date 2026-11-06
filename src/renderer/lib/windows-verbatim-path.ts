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

// A component that a plain Windows path cannot name: one ending in `.` or a
// space (Windows trims those) or a reserved device name such as `AUX.txt`.
const VERBATIM_ONLY_COMPONENT =
  /(?:^|[\\/])(?:[^\\/]*[. ]|(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9\u00b9\u00b2\u00b3])(?:\.[^\\/]*)?)(?=[\\/]|$)/i

/**
 * `path` as the Windows shell (`ShellExecuteExW`, `ILCreateFromPathW`) takes
 * it: a verbatim drive or UNC path loses its prefix. Elsewhere `path` is
 * returned as is, since `//?/x` is an ordinary path on macOS and Linux. A path
 * with a component only the verbatim form can name also stays as is: the
 * plain spelling would address a different file, so the shell call fails with
 * its own error instead.
 */
export function shellPath(path: string, os: string): string {
  if (os !== 'windows') return path
  const stripped = stripVerbatimPrefix(path)
  return VERBATIM_ONLY_COMPONENT.test(stripped) ? path : stripped
}
