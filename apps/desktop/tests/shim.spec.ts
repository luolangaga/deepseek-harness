/** The renderer transport shim: fetch/WebSocket impersonation over a scripted relay bridge. */

import { describe, expect, it, vi } from 'vitest'
import { installTransportShim, type ShimGlobals, type ShimSocketLike, type ShimWebSocketConstructor } from '../src/shim.ts'
import type { WireMessage, WireRequest } from '../src/ipc-wire.ts'

/** One fake page: records outbound relay requests, receives scripted replies, captures native traffic. */
const fakeWindow = (): {
  win: ShimGlobals
  requests: WireRequest[]
  deliver: (message: WireMessage) => void
  nativeFetch: ReturnType<typeof vi.fn>
  nativeSockets: unknown[]
} => {
  const requests: WireRequest[] = []
  const listeners = new Set<(event: { data: unknown }) => void>()
  const nativeFetch = vi.fn(async () => new Response('native'))
  const nativeSockets: unknown[] = []
  const FakeNativeWebSocket = function (this: unknown, url: string) {
    nativeSockets.push({ url, readyState: 1 })
    return { url, readyState: 1, addEventListener: () => {}, removeEventListener: () => {}, close: () => {} }
  }
  const NativeWS = FakeNativeWebSocket as unknown as ShimWebSocketConstructor
  NativeWS.CONNECTING = 0
  NativeWS.OPEN = 1
  NativeWS.CLOSING = 2
  NativeWS.CLOSED = 3
  const win: ShimGlobals = {
    fetch: nativeFetch,
    WebSocket: NativeWS,
    Response,
    addEventListener: (_type, listener) => { listeners.add(listener) },
    postMessage: (message) => {
      requests.push((message as { payload: WireRequest }).payload)
    },
  }
  return {
    win,
    requests,
    deliver: (message) => { for (const listener of listeners) listener({ data: { source: 'dsh-preload', payload: message } }) },
    nativeFetch,
    nativeSockets,
  }
}

/** The reply the relay sends for a successful fetch. */
function fetchReply(id: string): WireMessage {
  return { type: 'reply', id, ok: true, status: 200, headers: [['content-type', 'application/json']], body: new TextEncoder().encode('{"ok":true}') }
}

describe('installTransportShim', () => {
  it('routes /api fetches over the relay and rebuilds a Response from the reply', async () => {
    const { win, requests, deliver } = fakeWindow()
    installTransportShim(win)
    const promise = win.fetch('dsh://app/api/session.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    })
    expect(requests).toHaveLength(1)
    const request = requests[0]
    expect(request).toBeDefined()
    if (request === undefined) throw new Error('expected a relay request')
    expect(request).toMatchObject({
      type: 'request',
      kind: 'fetch',
      url: 'dsh://app/api/session.list',
      method: 'POST',
      headers: [['content-type', 'application/json']],
      body: JSON.stringify({ x: 1 }),
    })
    deliver(fetchReply(request.id))
    const response = await promise
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('passes non-API traffic through to the native fetch', async () => {
    const { win, requests, nativeFetch, deliver } = fakeWindow()
    installTransportShim(win)
    await win.fetch('https://example.com/data')
    expect(requests).toHaveLength(0)
    expect(nativeFetch).toHaveBeenCalledWith('https://example.com/data', undefined)
    deliver({ type: 'reply', id: 'unused', ok: true })
  })

  it('turns an ok:false reply into a transport throw', async () => {
    const { win, requests, deliver } = fakeWindow()
    installTransportShim(win)
    const promise = win.fetch('http://dsh.internal/api/session.list')
    const request = requests[0]
    expect(request).toBeDefined()
    if (request === undefined) throw new Error('expected a relay request')
    deliver({ type: 'reply', id: request.id, ok: false, error: 'host crashed' })
    await expect(promise).rejects.toThrow('host crashed')
  })

  it('passes non-downlink WebSocket URLs to the native constructor', () => {
    const { win, nativeSockets } = fakeWindow()
    installTransportShim(win)
    const socket = new win.WebSocket('wss://example.com/socket')
    expect(socket).toBeDefined()
    expect(nativeSockets).toHaveLength(1)
  })

  it('opens a downlink stream, delivers frames as text messages, and closes on stream-end', async () => {
    const { win, requests, deliver } = fakeWindow()
    installTransportShim(win)
    const opened: unknown[] = []
    const messages: unknown[] = []
    const closed: unknown[] = []
    const socket: ShimSocketLike = new win.WebSocket('ws://app/api/events.mux')
    socket.addEventListener('open', () => { opened.push(socket.readyState) })
    socket.addEventListener('message', (event) => { messages.push(event.data) })
    socket.addEventListener('close', () => { closed.push(socket.readyState) })
    const openRequest = requests[0]
    expect(openRequest).toBeDefined()
    if (openRequest === undefined) throw new Error('expected an open-stream request')
    expect(openRequest).toMatchObject({ kind: 'open-stream', path: '/api/events.mux' })
    const streamId = openRequest.streamId ?? ''
    expect(socket.readyState).toBe(0)
    // The relay echoes the open request's id; the streamId only tags frames.
    deliver({ type: 'reply', id: openRequest.id, ok: true })
    // The reply resolves the open request as a microtask.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(socket.readyState).toBe(1)
    expect(opened).toEqual([1])
    deliver({ type: 'frame', streamId, envelope: { type: 'server-request', rpcId: 'f1', method: 'session/event', payload: {} } })
    expect(messages).toEqual([JSON.stringify({ type: 'server-request', rpcId: 'f1', method: 'session/event', payload: {} })])
    deliver({ type: 'stream-end', streamId })
    expect(socket.readyState).toBe(3)
    expect(closed).toEqual([3])
  })

  it('client close sends close-stream and emits close once', () => {
    const { win, requests, deliver } = fakeWindow()
    installTransportShim(win)
    const closed: unknown[] = []
    const socket = new win.WebSocket('dsh://app/api/events.host')
    socket.addEventListener('close', () => { closed.push(socket.readyState) })
    const openRequest = requests[0]
    expect(openRequest).toBeDefined()
    if (openRequest === undefined) throw new Error('expected an open-stream request')
    const streamId = openRequest.streamId ?? ''
    deliver({ type: 'reply', id: streamId, ok: true })
    socket.close()
    expect(requests[1]).toMatchObject({ kind: 'close-stream', path: '/api/events.host', streamId })
    expect(socket.readyState).toBe(3)
    expect(closed).toHaveLength(1)
    socket.close()
    expect(closed).toHaveLength(1)
  })

  it('a failed open ends the socket instead of emitting open', async () => {
    const { win, requests, deliver } = fakeWindow()
    installTransportShim(win)
    const closed: unknown[] = []
    const socket = new win.WebSocket('ws://app/api/events.mux')
    socket.addEventListener('close', () => { closed.push(socket.readyState) })
    const openRequest = requests[0]
    expect(openRequest).toBeDefined()
    if (openRequest === undefined) throw new Error('expected an open-stream request')
    await Promise.resolve()
    deliver({ type: 'reply', id: openRequest.id, ok: false, error: 'invalid downlink stream' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(socket.readyState).toBe(3)
    expect(closed).toEqual([3])
  })

  it('installs once (the marker guards a double injection)', () => {
    const { win, requests } = fakeWindow()
    installTransportShim(win)
    installTransportShim(win)
    void win.fetch('dsh://app/api/session.list')
    expect(requests).toHaveLength(1)
  })
})
