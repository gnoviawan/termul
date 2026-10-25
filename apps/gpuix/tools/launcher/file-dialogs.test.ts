import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileDialogs, type PathPrompter } from '../../src/launcher/file-dialogs'

function recording(withSave = true): { prompter: PathPrompter; calls: unknown[] } {
  const calls: unknown[] = []
  const prompter: PathPrompter = {
    promptForPaths: async (options) => {
      calls.push(['open', options])
      return ['/home/ana/notes.txt']
    }
  }
  if (withSave) {
    prompter.promptForNewPath = async (options) => {
      calls.push(['save', options])
      return path.join(options.directory, options.suggestedName ?? 'untitled')
    }
  }
  return { prompter, calls }
}

describe('file dialogs', () => {
  test('open asks GPUI for files, several when the caller wants several', async () => {
    const { prompter, calls } = recording()
    const dialogs = createFileDialogs(() => prompter)
    expect(await dialogs.openFiles({ multiple: true })).toEqual(['/home/ana/notes.txt'])
    expect(await dialogs.openFiles({ multiple: false })).toEqual(['/home/ana/notes.txt'])
    expect(calls).toEqual([
      ['open', { files: true, multiple: true }],
      ['open', { files: true, multiple: false }]
    ])
  })

  test('save opens in the default folder with a bare suggested name', async () => {
    const { prompter, calls } = recording()
    const dialogs = createFileDialogs(
      () => prompter,
      () => '/home/ana'
    )
    expect(await dialogs.saveFile({ defaultPath: 'app.conf' })).toBe('/home/ana/app.conf')
    expect(await dialogs.saveFile({ defaultPath: '/srv/out/log.txt' })).toBe('/srv/out/log.txt')
    expect(calls).toEqual([
      ['save', { directory: '/home/ana', suggestedName: 'app.conf' }],
      ['save', { directory: '/srv/out', suggestedName: 'log.txt' }]
    ])
  })

  test('save fails with a reason on an addon without the save prompt', async () => {
    const dialogs = createFileDialogs(() => recording(false).prompter)
    await expect(dialogs.saveFile({ defaultPath: 'app.conf' })).rejects.toThrow(
      'This GPUIX build has no save dialog (native patch gpuix/0008)'
    )
  })

  test('both dialogs fail before the window exists', async () => {
    const dialogs = createFileDialogs(() => null)
    await expect(dialogs.openFiles({ multiple: true })).rejects.toThrow(
      'The window is not open yet'
    )
    await expect(dialogs.saveFile({})).rejects.toThrow('The window is not open yet')
  })

  test('a picked path becomes the File a browser file input would give', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gpuix-file-dialogs-'))
    const file = path.join(dir, 'notes.md')
    writeFileSync(file, '# hello')
    const picked = createFileDialogs(() => null).fileAt(file)
    expect(picked.name).toBe('notes.md')
    expect(picked.type).toBe('text/markdown')
    expect(await picked.text()).toBe('# hello')
  })
})
