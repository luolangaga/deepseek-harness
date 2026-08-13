/**
 * Renderer-world transport shim, injected into the served index.html before
 * the shell bundle: impersonates fetch and WebSocket for the /api surface so
 * the unmodified Web client (WebApiClient) runs over the desktop's IPC relay
 * instead of HTTP. This is the "fetch impersonation" seat the GUI-layering
 * note reserves for the Electron IPC carrier.
 *
 * The shim lives in the page's main world and cannot reach ipcRenderer, so it
 * talks to the sandboxed preload through window.postMessage with a
 * request/response correlation table; the preload forwards between the relay
 * and this channel. Everything not on the /api surface passes through to the
 * captured natives.
 */

import {
  downlinkKindOf,
  type WireMessage,
  type WireReply,
  type WireRequest,
} from './ipc-wire.ts'

/** The subset of the WebSocket surface WebApiClient reads. */
export interface ShimSocketLike {
  readonly url: string
  readyState: number
  addEventListener(type: 'open' | 'message' | 'close', listener: (event: { data?: unknown }) => void, options?: { once?: boolean }): void
  removeEventListener(type: 'open' | 'message' | 'close', listener: (event: { data?: unknown }) => void): void
  close(): void
}

/** Constructor type for the impersonated WebSocket: shim instances plus passthrough natives. */
export type ShimWebSocketConstructor = (new (url: string | URL, protocols?: string | string[]) => ShimSocketLike)
  & {
    CONNECTING: number
    OPEN: number
    CLOSING: number
    CLOSED: number
  }

/** The page globals the shim impersonates and the bridge it uses. */
export interface ShimGlobals {
  fetch: typeof fetch
  WebSocket: ShimWebSocketConstructor
  Response: typeof Response
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown, targetOrigin: string): void
}

/** Marker guarding against a double install (the shim bundle loads once per page). */
const INSTALLED_MARKER = '__DSH_TRANSPORT_SHIM__'

/** A pending request awaiting its relay reply. */
interface Pending {
  resolve(value: WireReply): void
  reject(error: Error): void
}

/** A subscribed downlink stream: the shim socket and the relay stream id. */
interface StreamRecord {
  socket: ShimSocket
  streamId: string
}

/** The API surface paths the shim owns; everything else belongs to the natives. */
function isApiPathname(pathname: string): boolean {
  return pathname.startsWith('/api/')
}

/** Read the pathname from a fetch/WebSocket input; unparsable inputs are not API traffic. */
function pathnameOf(input: string | URL | { url?: string | URL }): string | undefined {
  try {
    if (typeof input === 'string') return new URL(input).pathname
    if (input instanceof URL) return input.pathname
    return new URL(String(input.url)).pathname
  } catch {
    return undefined
  }
}

/** Read the URL string from a fetch/WebSocket input (a Request input stringifies as [object Object]). */
function urlOf(input: string | URL | { url?: string | URL }): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return String(input.url)
}

/** One shim downlink socket: mirrors the native WebSocket subset WebApiClient reads. */
class ShimSocket implements ShimSocketLike {
  readonly url: string
  readyState: number
  private readonly listeners = new Map<string, Array<{ listener: (event: { data?: unknown }) => void; once: boolean }>>()
  private closed = false
  private readonly closeRequest: () => void

  /**
   * Build the socket and request the relay stream.
   * @param url - the resolved WebSocket URL.
   * @param constants - the captured natives' ready-state constants.
   * @param request - the relay request sender.
   * @param streamId - the shim-minted correlation id doubling as the stream id.
   */
  constructor(
    url: string,
    private readonly constants: { CONNECTING: number; OPEN: number; CLOSING: number; CLOSED: number },
    request: (kind: WireRequest['kind'], params: Partial<WireRequest>) => Promise<WireReply>,
    streamId: string,
  ) {
    this.url = url
    this.readyState = constants.CONNECTING
    const path = new URL(url).pathname
    this.closeRequest = () => {
      // Fire and forget: the relay tears the pump down; the page may unload before it lands.
      void request('close-stream', { path, streamId })
    }
    void request('open-stream', { path, streamId }).then(
      (reply) => {
        if (this.closed) return
        this.readyState = reply.ok ? constants.OPEN : constants.CLOSED
        this.emit(reply.ok ? 'open' : 'close', {})
      },
      () => {
        this.end()
      },
    )
  }

  addEventListener(type: 'open' | 'message' | 'close', listener: (event: { data?: unknown }) => void, options?: { once?: boolean }): void {
    const bucket = this.listeners.get(type) ?? []
    bucket.push({ listener, once: options?.once === true })
    this.listeners.set(type, bucket)
  }

  removeEventListener(type: 'open' | 'message' | 'close', listener: (event: { data?: unknown }) => void): void {
    const bucket = this.listeners.get(type)
    if (bucket === undefined) return
    const next = bucket.filter(entry => entry.listener !== listener)
    if (next.length === 0) this.listeners.delete(type)
    else this.listeners.set(type, next)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = this.constants.CLOSED
    this.closeRequest()
    this.emit('close', {})
  }

  /** Deliver one frame as a WebSocket text message (WebApiClient JSON.parses event.data). */
  receiveFrame(envelope: unknown): void {
    if (this.closed) return
    this.emit('message', { data: JSON.stringify(envelope) })
  }

  /** End the stream from the relay side. */
  end(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = this.constants.CLOSED
    this.emit('close', {})
  }

  private emit(type: 'open' | 'message' | 'close', event: { data?: unknown }): void {
    const bucket = this.listeners.get(type)
    if (bucket === undefined) return
    for (const entry of [...bucket]) {
      if (entry.once) this.removeEventListener(type, entry.listener)
      entry.listener(event)
    }
  }
}

/**
 * Install the transport impersonation on a page: fetch and WebSocket are
 * replaced once (the marker guards reloads), the native captures pass
 * non-API traffic through, and /api traffic rides the postMessage relay.
 * @param win - the page globals to impersonate.
 */
export function installTransportShim(win: ShimGlobals): void {
  const marked = win as ShimGlobals & Record<string, unknown>
  if (marked[INSTALLED_MARKER] === true) return
  marked[INSTALLED_MARKER] = true

  const nativeFetch = win.fetch.bind(win)
  const NativeWebSocket = win.WebSocket
  const nativeResponse = win.Response
  const nativeConstants = {
    CONNECTING: NativeWebSocket.CONNECTING,
    OPEN: NativeWebSocket.OPEN,
    CLOSING: NativeWebSocket.CLOSING,
    CLOSED: NativeWebSocket.CLOSED,
  }

  let seq = 0
  const pending = new Map<string, Pending>()
  const streams = new Map<string, StreamRecord>()

  const deliver = (message: WireMessage): void => {
    switch (message.type) {
      case 'request':
        // Main never initiates page-side requests on this channel; the shape
        // shares the tag but not the direction.
        return
      case 'reply': {
        const entry = pending.get(message.id)
        if (entry === undefined) return
        pending.delete(message.id)
        entry.resolve(message)
        return
      }
      case 'frame': {
        const record = streams.get(message.streamId)
        record?.socket.receiveFrame(message.envelope)
        return
      }
      case 'stream-end': {
        const record = streams.get(message.streamId)
        if (record === undefined) return
        streams.delete(message.streamId)
        record.socket.end()
        return
      }
    }
  }

  win.addEventListener('message', (event) => {
    const data = event.data as { source?: string; payload?: WireMessage } | null
    if (data?.source !== 'dsh-preload' || data.payload === undefined) return
    deliver(data.payload)
  })

  const request = (kind: WireRequest['kind'], params: Partial<WireRequest>): Promise<WireReply> => {
    const id = String(++seq)
    const message: WireRequest = { type: 'request', id, kind, ...params }
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      win.postMessage({ source: 'dsh-shim', payload: message }, '*')
    })
  }

  const shimFetch: typeof fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const pathname = pathnameOf(input)
    if (pathname === undefined || !isApiPathname(pathname)) return nativeFetch(input, init)
    const method = init?.method ?? 'GET'
    const headers: [string, string][] = []
    if (init?.headers !== undefined) {
      for (const [name, value] of new Headers(init.headers)) headers.push([name, value])
    }
    const body = typeof init?.body === 'string' ? init.body : null
    return request('fetch', { url: urlOf(input), method, headers, body }).then(
      (reply) => {
        if (!reply.ok) throw new Error(reply.error ?? 'desktop relay failure')
        // The DOM BodyInit variance does not accept the widened Uint8Array
        // generic; the bytes are exactly what the relay serialized.
        return new nativeResponse(reply.body as unknown as BodyInit | null, {
          ...reply.status === undefined ? {} : { status: reply.status },
          ...reply.headers === undefined ? {} : { headers: reply.headers },
        })
      },
      (error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error))
      },
    )
  }

  const ShimWebSocket: ShimWebSocketConstructor = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const pathname = pathnameOf(url)
    if (pathname === undefined || downlinkKindOf(pathname) === undefined) {
      return new NativeWebSocket(String(url), protocols)
    }
    const streamId = String(++seq)
    const socket = new ShimSocket(String(url), nativeConstants, request, streamId)
    streams.set(streamId, { socket, streamId })
    return socket
  } as unknown as ShimWebSocketConstructor
  ShimWebSocket.CONNECTING = nativeConstants.CONNECTING
  ShimWebSocket.OPEN = nativeConstants.OPEN
  ShimWebSocket.CLOSING = nativeConstants.CLOSING
  ShimWebSocket.CLOSED = nativeConstants.CLOSED

  win.fetch = shimFetch
  win.WebSocket = ShimWebSocket
}
