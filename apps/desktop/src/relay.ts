/**
 * Main-side IPC relay: pairs one page's transport shim with the desktop
 * transport. Requests correlate by the shim-minted id, downlink streams by
 * their streamId, and every subscription dies with its page (navigation or
 * destroy). The renderer is this app's own surface, so there is no trust
 * fence here: the Web carrier's loopback and DNS-rebinding pinning has no
 * IPC counterpart — only our own webContents can reach these handlers.
 */

import type { FrameSink, DownlinkHandle } from './transport.ts'
import {
  downlinkKindOf,
  type DownlinkKind,
  type WireMessage,
  type WireReply,
  type WireRequest,
} from './ipc-wire.ts'

/** Default deadline for bounded unary calls (mirrors AbstractApiClient's DEFAULT_TIMEOUT_MS). */
const DEFAULT_UNARY_TIMEOUT_MS = 30_000

/** Downlink paths whose calls are user-paced (a system dialog may stay open) and carry no deadline. */
const USER_PACED_PATHS = new Set(['/api/host.pickDirectory'])

/** The channel one page is attached to (webContents in main, a stub in tests). */
export interface RelayChannel {
  /** Push one main→page message. */
  send(payload: WireMessage): void
  /** Subscribe to page→main requests; returns the unsubscriber. */
  onRequest(handler: (payload: unknown) => void): () => void
  /** Fires when the page navigates or its webContents is destroyed; returns the unsubscriber. */
  onNavigate(handler: () => void): () => void
}

/**
 * Narrow an IPC payload to a WireRequest envelope. Requests cross a process
 * boundary, so the shape check is real validation, not a type assertion.
 * @param value - the payload the wire delivered.
 * @returns the narrowed envelope, or false when the shape does not parse.
 */
function isWireRequest(value: unknown): value is WireRequest {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.type === 'request' && typeof record.id === 'string'
}

/** Transport surfaces the relay dispatches onto. */
export interface RelayDeps {
  /** Unary dispatch (the transport's shared fetch handler). */
  fetch(request: Request): Promise<Response>
  /** Downlink pump per stream. */
  openStream(kind: DownlinkKind, sink: FrameSink): DownlinkHandle
}

/**
 * One page's relay: correlate requests, forward frames, and tear streams down
 * with the page. Stream ids are shim-minted (the open request's own id), so
 * a reopen after reconnect never collides with a half-dead predecessor.
 */
export class DesktopRelay {
  private readonly streams = new Map<string, DownlinkHandle>()
  private readonly subscribed: (() => void)[]
  private attached = false

  /**
   * Build the relay over the transport surfaces.
   * @param deps - unary dispatch and the downlink pump factory.
   */
  constructor(private readonly deps: RelayDeps) {
    this.subscribed = []
  }

  /**
   * Attach to one channel: subscribe to requests and navigation, tear down on
   * detach. Idempotent per instance.
   * @param channel - the page's message channel.
   */
  attach(channel: RelayChannel): void {
    if (this.attached) return
    this.attached = true
    this.subscribed.push(channel.onRequest((payload) => {
      void this.handle(channel, payload)
    }))
    this.subscribed.push(channel.onNavigate(() => {
      this.closeAllStreams()
    }))
  }

  /** Detach the subscriptions; keeps any in-flight streams (the navigation hook owns teardown). */
  detach(): void {
    for (const unsubscribe of this.subscribed) unsubscribe()
    this.subscribed.length = 0
    this.attached = false
  }

  /**
   * Handle one page→main request: fetch dispatch with the bounded unary
   * deadline, or a downlink stream lifecycle op. Failures reply ok:false —
   * the shim converts them into transport errors the client's reconnect
   * loop already covers. Requests cross a wire, so the envelope is
   * validated before the switch trusts its shape.
   * @param channel - the requesting page's channel.
   * @param wireRequest - the payload the wire delivered.
   */
  async handle(channel: RelayChannel, wireRequest: unknown): Promise<void> {
    if (!isWireRequest(wireRequest)) return
    const request = wireRequest
    try {
      switch (request.kind) {
        case 'fetch': {
          channel.send(await this.dispatchFetch(request))
          return
        }
        case 'open-stream': {
          this.openStream(channel, request)
          return
        }
        case 'close-stream': {
          const streamId = request.streamId
          const handle = streamId === undefined ? undefined : this.streams.get(streamId)
          if (streamId !== undefined && handle !== undefined) {
            this.streams.delete(streamId)
            handle.dispose()
          }
          channel.send({ type: 'reply', id: request.id, ok: true })
          return
        }
      }
      // Unknown kind: the wire said nothing usable, so nothing answers.
      channel.send({ type: 'reply', id: request.id, ok: false, error: `unknown request kind ${String(request.kind)}` })
    } catch (error) {
      channel.send({
        type: 'reply',
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private openStream(channel: RelayChannel, request: WireRequest): void {
    const kind = request.path === undefined ? undefined : downlinkKindOf(request.path)
    const streamId = request.streamId
    if (kind === undefined || streamId === undefined || this.streams.has(streamId)) {
      channel.send({ type: 'reply', id: request.id, ok: false, error: `invalid downlink stream ${String(request.path)}` })
      return
    }
    const handle = this.deps.openStream(kind, (envelope) => {
      channel.send({ type: 'frame', streamId, envelope })
    })
    this.streams.set(streamId, handle)
    // Reply after subscribing so no frame can precede the open ack.
    channel.send({ type: 'reply', id: request.id, ok: true })
    void handle.done.then(() => {
      if (this.streams.get(streamId) !== handle) return
      this.streams.delete(streamId)
      channel.send({ type: 'stream-end', streamId })
    })
  }

  private async dispatchFetch(request: WireRequest): Promise<WireReply> {
    const rawUrl = request.url ?? ''
    let target: URL
    try {
      // The renderer resolves against the dsh:// origin (or the fake
      // authority); only the path and query carry meaning here.
      target = new URL(new URL(rawUrl).pathname + new URL(rawUrl).search, 'http://dsh.internal')
    } catch {
      return { type: 'reply', id: request.id, ok: false, error: `invalid request url ${JSON.stringify(rawUrl)}` }
    }
    const isUserPaced = USER_PACED_PATHS.has(target.pathname)
    const signal = isUserPaced ? undefined : AbortSignal.timeout(DEFAULT_UNARY_TIMEOUT_MS)
    const init: RequestInit = {
      method: request.method ?? 'GET',
      headers: request.headers ?? [],
      ...request.body === null || request.body === undefined ? {} : { body: request.body },
      ...signal === undefined ? {} : { signal },
    }
    let response: Response
    try {
      response = await this.deps.fetch(new Request(target, init))
    } catch (error) {
      // An aborted in-flight request reads as a transport failure; anything
      // else is a host crash the renderer's backoff retries against.
      return { type: 'reply', id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    let body: Uint8Array | null
    try {
      body = await response.arrayBuffer().then(buffer => new Uint8Array(buffer))
    } catch {
      body = null
    }
    return {
      type: 'reply',
      id: request.id,
      ok: true,
      status: response.status,
      headers: [...response.headers],
      body,
    }
  }

  private closeAllStreams(): void {
    for (const handle of this.streams.values()) handle.dispose()
    this.streams.clear()
  }
}
