/**
 * The IPC wire between the renderer transport shim and the main-process relay.
 * Type-only, browser-safe (no Node imports): both sides of the two-hop relay
 * (page shim ⇄ preload ⇄ main) serialize exactly these shapes. Requests
 * correlate by the shim-minted `id`; streams correlate by `streamId`, which is
 * the id of the `open-stream` request that created them.
 */

/** One page→main request. */
export interface WireRequest {
  type: 'request'
  /** Shim-minted correlation id (also the stream id for `open-stream`). */
  id: string
  kind: 'fetch' | 'open-stream' | 'close-stream'
  /** `fetch`: the renderer-resolved request URL. */
  url?: string
  /** `fetch`: the HTTP method. */
  method?: string
  /** `fetch`: request headers, in array form so no header name repeats. */
  headers?: [string, string][]
  /** `fetch`: the JSON string body, or null. */
  body?: string | null
  /** `open-stream` / `close-stream`: one of the two downlink paths. */
  path?: string
  /** `open-stream` / `close-stream`: the shim-minted stream id. */
  streamId?: string
}

/** Main→page reply to one request. */
export interface WireReply {
  type: 'reply'
  /** Echo of the request's id. */
  id: string
  ok: boolean
  /** `fetch` success: the response status. */
  status?: number
  /** `fetch` success: response headers. */
  headers?: [string, string][]
  /** `fetch` success: the response body bytes, or null. */
  body?: Uint8Array | null
  /** Failure: the reason. */
  error?: string
}

/** Main→page downlink frame (a full-form server-request envelope). */
export interface WireFrame {
  type: 'frame'
  streamId: string
  envelope: unknown
}

/** Main→page end of one downlink stream. */
export interface WireStreamEnd {
  type: 'stream-end'
  streamId: string
}

/** Every message on the relay channel. */
export type WireMessage = WireRequest | WireReply | WireFrame | WireStreamEnd

/** The two downlink event streams (the Web carrier's two WebSocket paths). */
const MUX_STREAM_PATH = '/api/events.mux'
const HOST_STREAM_PATH = '/api/events.host'

/** The downlink stream a request path selects. */
export type DownlinkKind = 'mux' | 'host'

/**
 * Map a downlink path to its stream kind.
 * @param path - the request path (`/api/events.mux` or `/api/events.host`).
 * @returns the kind, or undefined for any other path.
 */
export function downlinkKindOf(path: string): DownlinkKind | undefined {
  switch (path) {
    case MUX_STREAM_PATH: return 'mux'
    case HOST_STREAM_PATH: return 'host'
    default: return undefined
  }
}
