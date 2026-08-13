/** The desktop transport: dispatch composition and downlink pump semantics. */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { describe, expect, it } from 'vitest'
import { DesktopTransport } from '../src/transport.ts'

/** Build a context whose apiProxy is the given stub and whose connection service (the row's node half) hosts the transport. */
function buildTransport(apiProxy?: Partial<ApiProxy>): { ctx: Context; transport: DesktopTransport } {
  const ctx = new Context()
  if (apiProxy !== undefined) ctx.provide('apiProxy', apiProxy as ApiProxy)
  new HostConnectionService(ctx, [])
  const transport = new DesktopTransport(ctx, { printReady: false })
  return { ctx, transport }
}

/** One valid client-request envelope for `session.list`. */
function clientRequest(method: string, rpcId: string): string {
  return JSON.stringify({ type: 'client-request', rpcId, method, payload: {} })
}

/** An event source the test controls; the pump never validates frames, so the payload is free. */
function streamSource(yields: () => AsyncIterable<unknown>): ApiProxy['events']['mux'] & ApiProxy['events']['host'] {
  return async function * () {
    yield * yields() as AsyncIterable<never>
  }
}

describe('DesktopTransport', () => {
  it('answers 503 before the gateway mounts its apiProxy so the renderer retries with backoff', async () => {
    const { transport } = buildTransport()
    const response = await transport.fetch(new Request('http://dsh.internal/api/session.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: clientRequest('session.list', 'r1'),
    }))
    expect(response.status).toBe(503)
  })

  it('routes claimed endpoints through a registered interceptor before the apiProxy fallback', async () => {
    const { ctx, transport } = buildTransport()
    ctx.connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'session.list',
      async (endpoint, payload) => {
        expect(endpoint).toBe('session.list')
        expect(payload).toEqual({})
        return { ok: true as const, value: { items: [] } }
      },
      { authority: 'trusted-host' },
    )
    const response = await transport.fetch(new Request('http://dsh.internal/api/session.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: clientRequest('session.list', 'r1'),
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      type: 'server-response',
      rpcId: 'r1',
      result: { ok: true, value: { items: [] } },
    })
  })

  it('forwards a claimed endpoint whose method mismatches the path as a bad-request envelope', async () => {
    const { ctx, transport } = buildTransport()
    ctx.connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'session.list',
      async () => ({ ok: true as const, value: {} }),
      { authority: 'trusted-host' },
    )
    const response = await transport.fetch(new Request('http://dsh.internal/api/session.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: clientRequest('session.create', 'r1'),
    }))
    expect(response.status).toBe(200)
    const body = await response.json() as { result: { ok: boolean; error: { code: string } } }
    expect(body.result.ok).toBe(false)
    expect(body.result.error.code).toBe('bad-request')
  })

  it('pumps mux frames as full-form server requests until the source ends', async () => {
    const frame = {
      rpcId: RpcId('f1'),
      payload: { type: 'session/event', sessionId: 's1', event: { type: 'session/title', title: 'hello' } },
    }
    const apiProxy: Partial<ApiProxy> = {
      events: {
        mux: streamSource(async function * () { yield frame }),
        host: streamSource(async function * () {}),
      },
    }
    const { transport } = buildTransport(apiProxy)
    const envelopes: unknown[] = []
    const handle = transport.openStream('mux', (envelope) => { envelopes.push(envelope) })
    await handle.done
    expect(envelopes).toEqual([{
      type: 'server-request',
      rpcId: 'f1',
      method: 'session/event',
      payload: frame.payload,
    }])
  })

  it('emits one stream/error frame when the source throws, then ends', async () => {
    const apiProxy: Partial<ApiProxy> = {
      events: {
        mux: streamSource(async function * () { throw new Error('impl failure') }),
        host: streamSource(async function * () {}),
      },
    }
    const { transport } = buildTransport(apiProxy)
    const envelopes: Array<{ method: string; payload: { type: string } }> = []
    const handle = transport.openStream('mux', (envelope) => {
      envelopes.push(envelope as { method: string; payload: { type: string } })
    })
    await handle.done
    expect(envelopes).toHaveLength(1)
    const failure = envelopes[0]
    expect(failure).toBeDefined()
    if (failure === undefined) throw new Error('expected a failure frame')
    expect(failure.method).toBe('stream/error')
    expect(failure.payload.type).toBe('stream/error')
  })

  it('disposal aborts the source and settles the handle', async () => {
    const apiProxy: Partial<ApiProxy> = {
      events: {
        mux: streamSource(async function * () {
          yield { rpcId: RpcId('f1'), payload: { type: 'session/event', sessionId: 's1', event: { type: 'session/title', title: 'x' } } }
        }),
        host: streamSource(async function * () {}),
      },
    }
    const { transport } = buildTransport(apiProxy)
    const handle = transport.openStream('mux', () => {})
    handle.dispose()
    await handle.done
  })

  it('ends an opened stream immediately when the gateway never mounted', async () => {
    const { transport } = buildTransport()
    const handle = transport.openStream('mux', () => {})
    await handle.done
  })
})
