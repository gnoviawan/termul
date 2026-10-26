import { homedir } from 'node:os'
import path from 'node:path'

/** Where the transcript's Download buttons save, as a browser does: the user's Downloads folder. */
export function downloadsDir(): string {
  return process.env.XDG_DOWNLOAD_DIR || path.join(homedir(), 'Downloads')
}
