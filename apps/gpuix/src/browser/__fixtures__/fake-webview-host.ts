#!/usr/bin/env bun
// Stands in for termul-webview-host in tests: same stdio protocol, scripted by tab id and URL.
import { createInterface } from 'node:readline'

const send = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`)
send({ ev: 'ready', parent: 0x400001, pid: process.pid })

createInterface({ input: process.stdin }).on('line', (line) => {
  const cmd = JSON.parse(line)
  if (cmd.op === 'quit') process.exit(0)
  if (cmd.op === 'create' && cmd.id === 'crash') process.exit(3)
  if (cmd.op === 'navigate' && cmd.url.includes('fail')) {
    send({ ev: 'ack', req: cmd.req, ok: false, error: `cannot load ${cmd.url}` })
    return
  }
  send({ ev: 'ack', req: cmd.req, ok: true })
  if (cmd.op === 'create') {
    send({ ev: 'navigated', id: cmd.id, url: cmd.url })
    send({ ev: 'loaded', id: cmd.id, url: cmd.url })
    send({ ev: 'title', id: cmd.id, title: `title of ${cmd.id}` })
    send({ ev: 'console', id: cmd.id, level: 'log', text: 'page says hi' })
  }
  if (cmd.op === 'show' && cmd.id === 'grab') send({ ev: 'keyboard', owner: 'grab' })
  if (cmd.op === 'blur') send({ ev: 'keyboard', owner: null })
  console.error(`fake host got ${cmd.op}`)
})
