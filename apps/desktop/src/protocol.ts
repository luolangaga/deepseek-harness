/**
 * The dsh:// protocol handler: the desktop's static carrier. Serves the built
 * dsh-web-frontend dist with the boot manifest and the transport shim injected
 * into every index response, plus the plugin client bundles resolved through
 * the module registry. While the host boots, the index route answers with the
 * static splash page and the main process navigates to the real index once
 * the tree settled. This handler replaces the Web carrier's webserver +
 * frontend-static pair — no HTTP server exists in the desktop app.
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectBootManifest } from '@deepseek-ai/dsh-client-modules'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import { SPLASH_HTML } from './splash.ts'

/**
 * The canonical origin the desktop window loads. The authority must be
 * loopback-classified: the client derives `connection.isLoopback` from
 * `location.hostname`, and the desktop transport is an in-process IPC relay to
 * the local host, so a non-loopback authority would make every settings scope
 * bind memory-mode and the plugin configuration cards render nothing.
 * `localhost` earns the same classification the web client gets from its
 * `http://localhost` origin.
 */
export const DESKTOP_ORIGIN = 'dsh://localhost'

/** The renderer transport shim bundle, built beside lib/main.js by build/assets.mjs. */
const SHIM_PATH = fileURLToPath(new URL('../lib/shim.js', import.meta.url))

/** The WinUI-style window chrome stylesheet, built beside lib/main.js by build/assets.mjs. */
const CHROME_CSS_PATH = fileURLToPath(new URL('../lib/desktop-chrome.css', import.meta.url))

/** The module-registry face the handler consumes once the host settled. */
export interface ModuleRegistryFace {
  /** The composed boot entry graph (window.__DSH_BOOT__). */
  graph(): WebBootGraph
  /** Absolute path of a registered entry's client bundle. */
  clientPath(id: string): string | undefined
}

/** Boot state the index route gates on. */
export type BootState = { state: 'booting' } | { state: 'ready' } | { state: 'error'; message: string }

/** Dependencies for {@link createProtocolHandler}. */
export interface ProtocolDeps {
  /** Current boot state; the index route serves the splash until `ready`. */
  status(): BootState
  /** The module registry (undefined while the host is still booting). */
  modules(): ModuleRegistryFace | undefined
  /** Absolute path of the built frontend index.html. */
  distIndex: string
  /** The splash page body served while booting. */
  splashHtml?: string
  /** The transport shim bundle body; defaults to the built lib/shim.js (tests inject). */
  shimBody?: () => Promise<Uint8Array<ArrayBuffer>>
  /** The desktop chrome stylesheet body; defaults to the built lib/desktop-chrome.css (tests inject). */
  chromeCssBody?: () => Promise<Uint8Array<ArrayBuffer>>
}

/**
 * Node Buffer → ArrayBuffer-backed view for WHATWG Response bodies. The cast
 * is generic variance only: a Buffer IS a Uint8Array over its own buffer, and
 * the response never outlives it.
 */
function asBodyBytes(buffer: Buffer): Uint8Array<ArrayBuffer> {
  return buffer as unknown as Uint8Array<ArrayBuffer>
}

/** Read the built shim bundle (the protocol default). */
async function readBuiltShim(): Promise<Uint8Array<ArrayBuffer>> {
  return asBodyBytes(await readFile(SHIM_PATH))
}

/** Read the built desktop chrome stylesheet (the protocol default). */
async function readBuiltChromeCss(): Promise<Uint8Array<ArrayBuffer>> {
  return asBodyBytes(await readFile(CHROME_CSS_PATH))
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/** Dist location is workspace knowledge of this app: resolved through the frontend package exports, not configured. */
export function resolveDistIndex(): string {
  const require = createRequire(import.meta.url)
  try {
    return require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
  } catch {
    /* v8 ignore next 2 -- reachable only on a checkout without a built dist; the boot smoke builds it */
    throw new Error('dsh-desktop: frontend dist not built; run pnpm run build from the repository root first')
  }
}

/**
 * Create the dsh:// request handler. Registered with Electron's
 * protocol.handle before the window loads; serves index (splash until ready,
 * then dist + boot manifest + shim), the shim bundle, plugin client bundles,
 * and the dist assets, with the traversal guard the Web static server locks.
 * @param deps - boot status, module registry, and dist anchors.
 * @returns the WHATWG Request→Response handler.
 */
export function createProtocolHandler(deps: ProtocolDeps): (request: Request) => Promise<Response> {
  const distRoot = dirname(deps.distIndex)
  const splashHtml = deps.splashHtml ?? SPLASH_HTML
  const shimBody = deps.shimBody ?? readBuiltShim
  const chromeCssBody = deps.chromeCssBody ?? readBuiltChromeCss

  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 })
    }
    const pathname = new URL(request.url).pathname
    if (pathname === '/' || pathname === '/index.html') {
      if (deps.status().state !== 'ready') return htmlResponse(splashHtml)
      const modules = deps.modules()
      const html = modules === undefined ? await readFile(deps.distIndex, 'utf8') : injectDesktop(await readFile(deps.distIndex, 'utf8'), modules)
      return htmlResponse(html)
    }
    if (pathname === '/shim.js') {
      return new Response(await shimBody(), { headers: { 'content-type': contentTypeOf('.js') } })
    }
    if (pathname === '/desktop-chrome.css') {
      return new Response(await chromeCssBody(), { headers: { 'content-type': contentTypeOf('.css') } })
    }
    if (pathname.startsWith('/plugins/')) {
      return servePluginBundle(pathname, deps.modules())
    }
    return serveDistAsset(pathname, request, distRoot, deps.distIndex)
  }
}

/** Inject the boot manifest, the transport shim, and the desktop chrome into the dist index (all before the deferred app entry). */
function injectDesktop(html: string, modules: ModuleRegistryFace): string {
  const withManifest = injectBootManifest(html, modules.graph())
  const head = withManifest.indexOf('<head>')
  const injections = `<script src="${DESKTOP_ORIGIN}/shim.js"></script>\n`
    + `  <link rel="stylesheet" href="${DESKTOP_ORIGIN}/desktop-chrome.css" />`
  return head === -1 ? `${injections}${withManifest}` : `${withManifest.slice(0, head + 6)}${injections}${withManifest.slice(head + 6)}`
}

function htmlResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': contentTypeOf('.html') } })
}

/** The content type for a file extension; unknown extensions ship as octet-stream. */
function contentTypeOf(extension: string): string {
  return MIME[extension] ?? 'application/octet-stream'
}

/** Serve one registered plugin client bundle (or its source map) from the module registry. */
async function servePluginBundle(pathname: string, modules: ModuleRegistryFace | undefined): Promise<Response> {
  const bundleSuffix = '/client.js'
  const mapSuffix = '/client.js.map'
  const isSourceMap = pathname.endsWith(mapSuffix)
  const suffix = isSourceMap ? mapSuffix : bundleSuffix
  if (modules === undefined || !pathname.endsWith(suffix)) {
    return new Response('not found', { status: 404 })
  }
  const id = pathname.slice('/plugins/'.length, -suffix.length)
  const clientPath = modules.clientPath(id)
  if (clientPath === undefined) return new Response('not found', { status: 404 })
  try {
    const body = await readFile(`${clientPath}${isSourceMap ? '.map' : ''}`)
    return new Response(body, {
      headers: {
        'content-type': isSourceMap ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      },
    })
  } catch {
    // Registered but unreadable (bundle not built yet): loud 404 beats a silent empty page.
    return new Response('not found', { status: 404 })
  }
}

/**
 * Serve one dist asset with the traversal guard; a miss is 404 (no SPA
 * fallback on the desktop). Exported for the traversal test: WHATWG URL
 * parsing normalizes dot segments before the handler dispatches, so the
 * guard is defense-in-depth against hostile decoded pathnames.
 * @param pathname - the decoded request pathname.
 * @param request - the original request (method and Range header).
 * @param distRoot - the dist directory root.
 * @param distIndex - absolute path of index.html inside distRoot.
 * @returns the asset response, 403 on traversal, or 404 on a miss.
 */
export async function serveDistAsset(
  pathname: string,
  request: Request,
  distRoot: string,
  distIndex: string,
): Promise<Response> {
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection: the target must stay under distRoot. `sep`, not '/':
  // resolve() emits backslash paths on Windows, where a '/' suffix would
  // reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    return new Response('forbidden', { status: 403 })
  }
  if (target === distRoot || target === distIndex) {
    return htmlResponse(await readFile(distIndex, 'utf8'))
  }
  try {
    const body = await readFile(target)
    return fileResponse(asBodyBytes(body), extname(target), request)
  } catch {
    return new Response('not found', { status: 404 })
  }
}

/** One static file response, honoring a single byte range (fonts and media load with Range probes). */
function fileResponse(body: Uint8Array<ArrayBuffer>, extension: string, request: Request): Response {
  const headers: Record<string, string> = { 'content-type': contentTypeOf(extension) }
  const range = request.headers.get('range')
  if (range !== null) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match !== null && (match[1] !== '' || match[2] !== '')) {
      const start = match[1] === '' ? Math.max(0, body.length - Number(match[2])) : Number(match[1])
      const end = match[2] === '' ? body.length - 1 : Number(match[2])
      if (start <= end && end < body.length) {
        headers['content-range'] = `bytes ${start}-${end}/${body.length}`
        return new Response(body.subarray(start, end + 1), { status: 206, headers })
      }
    }
    // Unparsable or unsatisfiable range: the full body is the honest fallback.
  }
  return new Response(body, { headers })
}
