import type {
  WsAdapter,
  WsAdapterConfig,
  WsInboundMessage,
  WsOutboundMessage,
  WsResponse,
  WsEvent,
} from '@shared/types/ws.types'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timeout: ReturnType<typeof setTimeout>
}

interface EventListener {
  event: string
  callback: (payload: Record<string, unknown>) => void
}

export function createWsAdapter(config: WsAdapterConfig): WsAdapter {
  const {
    url,
    authToken,
    reconnectInterval = 3000,
    maxReconnectAttempts = 10,
  } = config

  let socket: WebSocket | null = null
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let isAuthenticated = false
  let isConnecting = false
  const pendingRequests = new Map<string, PendingRequest>()
  const eventListeners: EventListener[] = []
  const disconnectCallbacks: (() => void)[] = []

  const generateId = (): string => `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

  const send = (message: WsInboundMessage): void => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message))
    }
  }

  const handleMessage = (raw: string): void => {
    try {
      const message = JSON.parse(raw) as WsOutboundMessage

      if (message.type === 'response') {
        const pending = pendingRequests.get(message.id)
        if (pending) {
          clearTimeout(pending.timeout)
          pendingRequests.delete(message.id)
          if (message.success) {
            pending.resolve(message.data)
          } else {
            pending.reject(new Error(message.error || 'Unknown error'))
          }
        }
      } else if (message.type === 'event') {
        const wsEvent = message as WsEvent
        for (const listener of eventListeners) {
          if (listener.event === wsEvent.event) {
            listener.callback(wsEvent.payload || {})
          }
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }

  const connect = (): Promise<void> => {
    if (socket?.readyState === WebSocket.OPEN && isAuthenticated) {
      return Promise.resolve()
    }

    if (isConnecting) {
      return new Promise((resolve) => {
        const check = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN && isAuthenticated) {
            clearInterval(check)
            resolve()
          }
        }, 100)
      })
    }

    return new Promise((resolve, reject) => {
      isConnecting = true
      const timeout = setTimeout(() => {
        isConnecting = false
        reject(new Error('WebSocket connection timeout'))
      }, 10000)

      try {
        socket = new WebSocket(url)
      } catch (error) {
        isConnecting = false
        clearTimeout(timeout)
        reject(error)
        return
      }

      socket.onopen = () => {
        send({ type: 'auth', token: authToken })
      }

      socket.onmessage = (event: MessageEvent) => {
        const raw = event.data as string

        if (!isAuthenticated) {
          try {
            const parsed = JSON.parse(raw) as WsResponse
            if (parsed.type === 'response' && parsed.id === 'auth') {
              if (parsed.success) {
                isAuthenticated = true
                isConnecting = false
                reconnectAttempts = 0
                clearTimeout(timeout)
                resolve()
              } else {
                isConnecting = false
                clearTimeout(timeout)
                reject(new Error(parsed.error || 'Authentication failed'))
                socket?.close()
              }
            }
          } catch {
            // Not auth response, ignore
          }
          return
        }

        handleMessage(raw)
      }

      socket.onclose = () => {
        isAuthenticated = false
        isConnecting = false

        for (const [, pending] of pendingRequests) {
          clearTimeout(pending.timeout)
          pending.reject(new Error('WebSocket disconnected'))
        }
        pendingRequests.clear()

        for (const callback of disconnectCallbacks) {
          callback()
        }

        if (reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++
          reconnectTimer = setTimeout(() => {
            connect().catch(() => {})
          }, reconnectInterval)
        }
      }

      socket.onerror = () => {
        // onclose will handle cleanup
      }
    })
  }

  const disconnect = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    reconnectAttempts = maxReconnectAttempts
    isAuthenticated = false
    isConnecting = false

    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('WebSocket disconnected'))
    }
    pendingRequests.clear()

    if (socket) {
      socket.onclose = null
      socket.close()
      socket = null
    }
  }

  const invoke = <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const id = generateId()
      const timeout = setTimeout(() => {
        pendingRequests.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, 30000)

      pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout })
      send({ type: 'request', id, method, params })
    })
  }

  const listen = (
    event: string,
    callback: (payload: Record<string, unknown>) => void,
  ): (() => void) => {
    const listener: EventListener = { event, callback }
    eventListeners.push(listener)
    return () => {
      const index = eventListeners.indexOf(listener)
      if (index >= 0) eventListeners.splice(index, 1)
    }
  }

  const isConnected = (): boolean => socket?.readyState === WebSocket.OPEN && isAuthenticated

  const onDisconnect = (callback: () => void): (() => void) => {
    disconnectCallbacks.push(callback)
    return () => {
      const index = disconnectCallbacks.indexOf(callback)
      if (index >= 0) disconnectCallbacks.splice(index, 1)
    }
  }

  return { connect, disconnect, invoke, listen, isConnected, onDisconnect }
}
