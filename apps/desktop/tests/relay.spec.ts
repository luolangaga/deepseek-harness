/** The IPC relay: fetch dispatch, stream lifecycle, and page-bound teardown. */

import { describe, expect, it, vi } from 'vitest'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { DesktopRelay, type RelayChannel, type RelayDeps } from '../src/relay.ts'
import type { FrameSink } from '../src/transport.ts'
import type { DownlinkKind } from '../src/ipc-wire.ts'
import type { WireFrame, WireMessage, WireReply, WireRequest, WireStreamEnd } from '../src/ipc-wire.ts'

/** A scripted channel: records sends, exposes the request handler and the navigation trigger. */
function makeChannel(): { channel: RelayChannel; sent: WireMessage[]; sendRequest: (payload: WireRequest) => void; navigate: () => void } {
  const sent: WireMessage[] = []
  let requestHandler: ((payload: WireRequest) => void) | undefined
  let navigateHandler: (() => void) | undefined
  const channel: RelayChannel = {
    send: (payload) => { sent.push(payload) },
    onRequest: (handler) => {
      requestHandler = handler
      return () => { requestHandler = undefined }
    },
    onNavigate: (handler) => {
      navigateHandler = handler
      return () => { navigateHandler = undefined }
    },
  }
  return {
    channel,
    sent,
    sendRequest: (payload) => { requestHandler?.(payload) },
    navigate: () => { navigateHandler?.() },
  }
}

/** A stream handle the test settles manually; the dispose spy is exposed for call-count assertions. */
function manualStream(): { handle: ReturnType<RelayDeps['openStream']>; done: () => void; disposeSpy: ReturnType<typeof vi.fn> } {
  let done!: () => void
  const finished = new Promise<void>((resolve) => { done = resolve })
  const disposeSpy = vi.fn(() => { done() })
  return {
    handle: { dispose: disposeSpy, done: finished },
    done,
    disposeSpy,
  }
}

/** The one sent message, narrowed to a reply. */
function replyOf(sent: WireMessage[], index: number): WireReply {
  const message = sent[index]
  expect(message).toBeDefined()
  if (message === undefined || message.type !== 'reply') throw new Error('expected a reply')
  return message
}

describe('DesktopRelay', () => {
  it('dispatches a fetch request and replies with status, headers, and body bytes', async () => {
    const fetch = vi.fn(async (_request: Request) =>
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const relay = new DesktopRelay({ fetch, openStream: () => manualStream().handle })
    const { channel, sent, sendRequest } = makeChannel()
    relay.attach(channel)
    sendRequest({ type: 'request', id: 'r1', kind: 'fetch', url: 'dsh://app/api/session.list', method: 'POST', headers: [['content-type', 'application/json']], body: '{"x":1}' })
    await vi.waitFor(() => { expect(sent.length).toBe(1) })
    const reply = replyOf(sent, 0)
    expect(reply.id).toBe('r1')
    expect(reply.ok).toBe(true)
    expect(reply.status).toBe(200)
    expect(reply.headers).toContainEqual(['content-type', 'application/json'])
    expect(new TextDecoder().decode(reply.body ?? undefined)).toBe(JSON.stringify({ ok: true }))
    const calledArgs = fetch.mock.calls[0]
    expect(calledArgs).toBeDefined()
    if (calledArgs === undefined) throw new Error('expected a dispatched request')
    const called = calledArgs[0]
    expect(called.url).toBe('http://dsh.internal/api/session.list')
    expect(called.method).toBe('POST')
    expect(await called.text()).toBe('{"x":1}')
  })

  it('replies ok:false when the dispatch throws', async () => {
    const fetch = vi.fn(async () => { throw new Error('host crashed') })
    const relay = new DesktopRelay({ fetch, openStream: () => manualStream().handle })
    const { channel, sent, sendRequest } = makeChannel()
    relay.attach(channel)
    sendRequest({ type: 'request', id: 'r2', kind: 'fetch', url: 'dsh://app/api/session.list' })
    await vi.waitFor(() => { expect(sent.length).toBe(1) })
    expect(replyOf(sent, 0)).toEqual({ type: 'reply', id: 'r2', ok: false, error: 'host crashed' })
  })

  it('acknowledges an open stream, forwards frames, and ends with the pump', async () => {
    const stream = manualStream()
    const openStream = vi.fn((_kind: DownlinkKind, _sink: FrameSink) => stream.handle)
    const relay = new DesktopRelay({ fetch: async () => new Response(), openStream })
    const { channel, sent, sendRequest } = makeChannel()
    relay.attach(channel)
    sendRequest({ type: 'request', id: 's1', kind: 'open-stream', path: '/api/events.mux', streamId: 's1' })
    await vi.waitFor(() => { expect(sent.length).toBe(1) })
    expect(openStream).toHaveBeenCalledWith('mux', expect.any(Function))
    expect(sent[0]).toEqual({ type: 'reply', id: 's1', ok: true })
    const calledArgs = openStream.mock.calls[0]
    expect(calledArgs).toBeDefined()
    if (calledArgs === undefined) throw new Error('expected an opened stream')
    const sink = calledArgs[1]
    sink({ type: 'server-request', rpcId: RpcId('f1'), method: 'session/event', payload: {} })
    const frame: WireFrame = { type: 'frame', streamId: 's1', envelope: { type: 'server-request', rpcId: 'f1', method: 'session/event', payload: {} } }
    expect(sent[1]).toEqual(frame)
    stream.done()
    await vi.waitFor(() => { expect(sent.length).toBe(3) })
    const end: WireStreamEnd = { type: 'stream-end', streamId: 's1' }
    expect(sent[2]).toEqual(end)
  })

  it('rejects an unknown downlink path', async () => {
    const relay = new DesktopRelay({ fetch: async () => new Response(), openStream: () => manualStream().handle })
    const { channel, sent, sendRequest } = makeChannel()
    relay.attach(channel)
    sendRequest({ type: 'request', id: 's2', kind: 'open-stream', path: '/api/unknown', streamId: 's2' })
    await vi.waitFor(() => { expect(sent.length).toBe(1) })
    expect(replyOf(sent, 0)).toMatchObject({ type: 'reply', id: 's2', ok: false })
  })

  it('close-stream disposes the pump and acknowledges', async () => {
    const stream = manualStream()
    const relay = new DesktopRelay({ fetch: async () => new Response(), openStream: () => stream.handle })
    const { channel, sent, sendRequest } = makeChannel()
    relay.attach(channel)
    sendRequest({ type: 'request', id: 's3', kind: 'open-stream', path: '/api/events.host', streamId: 's3' })
    await vi.waitFor(() => { expect(sent.length).toBe(1) })
    sendRequest({ type: 'request', id: 'c1', kind: 'close-stream', path: '/api/events.host', streamId: 's3' })
    await vi.waitFor(() => { expect(sent.length).toBe(2) })
    expect(stream.disposeSpy).toHaveBeenCalledTimes(1)
    expect(sent[1]).toEqual({ type: 'reply', id: 'c1', ok: true })
    // The settled pump must not emit stream-end after an explicit close.
    stream.done()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sent).toHaveLength(2)
  })

  it('navigation disposes every live stream', async () => {
    const first = manualStream()
    const second = manualStream()
    const openStream = vi.fn()
      .mockReturnValueOnce(first.handle)
      .mockReturnValueOnce(second.handle)
    const relay = new DesktopRelay({ fetch: async () => new Response(), openStream })
    const { channel, sent, sendRequest, navigate } = makeChannel()
    relay.attach(channel)
    sendRequest({ type: 'request', id: 's4', kind: 'open-stream', path: '/api/events.mux', streamId: 's4' })
    sendRequest({ type: 'request', id: 's5', kind: 'open-stream', path: '/api/events.host', streamId: 's5' })
    await vi.waitFor(() => { expect(sent.length).toBe(2) })
    navigate()
    expect(first.disposeSpy).toHaveBeenCalledTimes(1)
    expect(second.disposeSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores envelopes the wire never validated and replies ok:false to unparsable urls', async () => {
    const relay = new DesktopRelay({ fetch: async () => new Response(), openStream: () => manualStream().handle })
    const { channel, sent, sendRequest } = makeChannel()
    relay.attach(channel)
    sendRequest({ type: 'bogus' } as unknown as WireRequest)
    sendRequest({ type: 'request', id: 'bad', kind: 'fetch' })
    await vi.waitFor(() => { expect(sent.length).toBe(1) })
    expect(replyOf(sent, 0)).toMatchObject({ type: 'reply', id: 'bad', ok: false })
  })
})
