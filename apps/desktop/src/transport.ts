/**
 * The desktop IPC transport: the Electron seat the GUI-layering note reserves
 * for the "IPC bridge subclass". The `connection` row's node half provides
 * `ctx.connection` — the gateway's Typert interceptor registers through it,
 * exactly as under the Web carrier — and this service consumes its shared
 * `/api` fetch handler for the unary uplink plus pumps the mux/host downlink
 * streams. No HTTP server exists in this composition: this plugin is the
 * whole carriage.
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { RpcId, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import type { HostFrame, MuxFrame, RpcRequest, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { DownlinkKind } from './ipc-wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The desktop IPC transport (provided by the desktop app's startHost). */
    desktopTransport: DesktopTransport
  }
}

/** One subscribed downlink pump: disposal aborts the source, `done` resolves at pump exit. */
export interface DownlinkHandle {
  /** Abort the source stream and stop forwarding frames. */
  dispose(): void
  /** Resolves when the pump exits (frames exhausted, abort, or impl failure). */
  done: Promise<void>
}

/** Frame delivery sink: one full-form server-request envelope per frame. */
export type FrameSink = (envelope: ServerRequest) => void

/** Options for the transport service. */
export interface DesktopTransportOptions {
  /** Print the readiness line after Loader settlement (the keyless smoke's signal). */
  printReady?: boolean
  /** Readiness-line sink; defaults to console.log. */
  log?: (line: string) => void
}

/** The readiness line, printed after Loader settlement — the supervisor signal the keyless smoke reads. */
export const READY_LINE = 'dsh desktop: ready'

/** Complete a narrow frame into its wire full form (method = frame type); mirrors the WebSocket downlink. */
function serverRequest(frame: RpcRequest<MuxFrame | HostFrame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
}

/** One impl-failure frame: a fresh rpcId, like any server-initiated push (mirrors the WebSocket downlink). */
function failureFrame(error: unknown): RpcRequest<MuxFrame | HostFrame> {
  return {
    rpcId: RpcId(randomUUID()),
    payload: {
      type: 'stream/error',
      error: { code: 'internal', message: String(error), details: {} },
    },
  }
}

/**
 * The desktop carrier service: unary dispatch and downlink pumps over the
 * in-process gateway, consumed by the IPC relay. Unary requests race the
 * boot (the renderer retries with backoff), so a missing apiProxy reads as
 * carrier 503 rather than a crash.
 */
export class DesktopTransport extends Service {
  private fetchHandler: { fetch(request: Request): Promise<Response> } | undefined
  private readonly log: (line: string) => void

  /**
   * Consume the connection row's shared handler and build the dispatch faces.
   * @param ctx - the transport plugin's context (the startHost root child).
   * @param options - readiness print and sink.
   */
  constructor(ctx: Context, options: DesktopTransportOptions = {}) {
    super(ctx, 'desktopTransport')
    this.log = options.log ?? ((line) => { console.log(line) })
    // The connection node half provides exactly a HostConnectionService; its
    // shared-handler composition is the same dispatch the Web carrier builds —
    // interceptor first, then the toFetchHandler(apiProxy) fallback. The
    // connection row mounts with the tree, after this prepare-phase plugin, so
    // a present service binds now and an absent one rides the inject callback.
    const bindHandler = (connection: HostConnectionService): void => {
      this.fetchHandler = connection.createSharedFetchHandler('/api', {
        fetch: (request: Request): Promise<Response> => {
          const apiProxy = ctx.get('apiProxy')
          if (apiProxy === undefined) {
            return Promise.resolve(new Response('host not ready', { status: 503 }))
          }
          return toFetchHandler(apiProxy).fetch(request)
        },
      })
    }
    const present = ctx.get('connection') as HostConnectionService | undefined
    if (present !== undefined) bindHandler(present)
    else {
      ctx.inject(['connection'], (connectionCtx) => {
        bindHandler(connectionCtx.connection as HostConnectionService)
      })
    }
    if (options.printReady ?? true) {
      // The readiness line must not print while sibling rows (the api-gateway)
      // are still mounting: await Loader settlement, like the Web URL line.
      const settled = ctx.get('loader')?.await()
      if (settled === undefined) this.printReady()
      else {
        void settled.then(() => {
          // The tree can be disposed while the boot was in flight; a readiness
          // line for a dead host would only mislead.
          if (ctx.get('loader') !== undefined) this.printReady()
        }, () => {})
      }
    }
  }

  /**
   * Dispatch one unary request through the shared handler (gateway interceptor
   * first, apiProxy fallback).
   * @param request - the renderer's request, normalized by the relay.
   * @returns the carrier response (business errors arrive as HTTP 200 + ServerResponse).
   */
  fetch(request: Request): Promise<Response> {
    if (this.fetchHandler === undefined) {
      return Promise.resolve(new Response('host not ready', { status: 503 }))
    }
    return this.fetchHandler.fetch(request)
  }

  /**
   * Subscribe to one downlink stream and pump its frames to the sink.
   * The renderer's strict readiness handshake opens streams only after a
   * unary round-trip succeeded, so an absent apiProxy means the tree is
   * exiting — the handle ends immediately rather than wedging.
   * @param kind - the mux (all-session) or host stream.
   * @param sink - receives one full-form envelope per frame.
   * @returns the handle: dispose aborts, done resolves at pump exit.
   */
  openStream(kind: DownlinkKind, sink: FrameSink): DownlinkHandle {
    const apiProxy = this.ctx.get('apiProxy')
    const abort = new AbortController()
    if (apiProxy === undefined) {
      return { dispose: () => { abort.abort() }, done: Promise.resolve() }
    }
    const frames = kind === 'mux'
      ? apiProxy.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal)
      : apiProxy.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, abort.signal)
    return {
      dispose: () => { abort.abort() },
      done: this.pump(frames, sink, abort),
    }
  }

  private printReady(): void {
    this.log(READY_LINE)
  }

  private async pump(
    frames: AsyncIterable<RpcRequest<MuxFrame | HostFrame>>,
    sink: FrameSink,
    abort: AbortController,
  ): Promise<void> {
    try {
      for await (const frame of frames) sink(serverRequest(frame))
    } catch (error) {
      if (!abort.signal.aborted) {
        try {
          sink(serverRequest(failureFrame(error)))
        } catch {
          // The relay tore down mid-frame; no downstream remains to receive the failure frame.
        }
      }
    } finally {
      abort.abort()
    }
  }
}
