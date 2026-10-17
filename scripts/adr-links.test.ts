import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const ADR_PATH = /(?:docs\/|\.\/)adr\/[\w.-]+\.md/g

function adrReferences(): string[] {
  const out = execFileSync('git', ['grep', '-E', '(docs/|\\./)adr/[A-Za-z0-9_.-]+\\.md'], {
    cwd: root,
    encoding: 'utf8'
  })
  return out.split('\n').flatMap((line) => {
    const sep = line.indexOf(':')
    const file = line.slice(0, sep)
    return [...line.slice(sep + 1).matchAll(ADR_PATH)].map(([ref]) =>
      ref.startsWith('./') ? join(dirname(file), ref) : ref
    )
  })
}

describe('ADR references', () => {
  it('point at ADR files that exist in the repo', () => {
    const missing = adrReferences().filter((ref) => !existsSync(join(root, ref)))
    expect(missing).toEqual([])
  })
})
