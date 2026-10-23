import net from 'node:net'

/**
 * Transparent TCP relay in front of termul-server. The client under test
 * connects here instead of to the server, so the byte counts cover every
 * HTTP response and WebSocket frame it receives, whatever the client is
 * (Chromium, WebKitGTK, GPUIX). HTTP Host and Origin both carry the relay
 * port, so the server's same-origin check still passes.
 */
export interface ByteProxy {
  url: string
  /** Bytes server→client and client→server since start or the last reset. */
  counters(): { down: number; up: number }
  reset(): void
  close(): Promise<void>
}

export async function startByteProxy(targetPort: number, listenPort: number): Promise<ByteProxy> {
  let down = 0
  let up = 0
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1')
    sockets.add(client)
    sockets.add(upstream)
    client.on('data', (chunk) => {
      up += chunk.length
    })
    upstream.on('data', (chunk) => {
      down += chunk.length
    })
    client.pipe(upstream)
    upstream.pipe(client)
    const drop = () => {
      client.destroy()
      upstream.destroy()
      sockets.delete(client)
      sockets.delete(upstream)
    }
    client.on('error', drop)
    upstream.on('error', drop)
    client.on('close', drop)
    upstream.on('close', drop)
  })
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  server.once('error', reject)
  server.listen(listenPort, '127.0.0.1', () => resolve())
  await promise
  return {
    url: `http://127.0.0.1:${listenPort}`,
    counters: () => ({ down, up }),
    reset: () => {
      down = 0
      up = 0
    },
    close: async () => {
      for (const s of sockets) s.destroy()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }
}
