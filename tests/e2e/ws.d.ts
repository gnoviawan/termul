/**
 * Minimal structural types for the transitive `ws` package used by the E2E
 * helpers (the repo has no @types/ws; only the event surface we consume is
 * declared).
 */
declare module 'ws' {
  export class WebSocket {
    constructor(url: string)
    send(data: string): void
    close(): void
    on(event: 'open', listener: () => void): void
    on(event: 'message', listener: (data: unknown) => void): void
    on(event: 'error', listener: (err: Error) => void): void
  }
}
