/** The dsh:// protocol handler: index gating, manifest/shim injection, plugin bundles, assets, and traversal. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProtocolHandler, DESKTOP_ORIGIN, serveDistAsset, type ModuleRegistryFace, type ProtocolDeps } from '../src/protocol.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-desktop-protocol-'))
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'index.html'), '<!doctype html>\n<html><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>\n')
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log("app")\n')
  writeFileSync(join(root, 'assets', 'font.woff2'), 'W0FF2-bytes')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const modules: ModuleRegistryFace = {
  graph: () => ({
    rev: 'rev1',
    entries: [{ id: '@fixture/plugin', url: '/plugins/@fixture/plugin/client.js?rev=rev1', rev: 'rev1' }],
  }),
  clientPath: id => (id === '@fixture/plugin' ? join(root, 'plugin-client.js') : undefined),
}

function handler(state: ProtocolDeps['status']): (request: Request) => Promise<Response> {
  return createProtocolHandler({
    status: state,
    modules: () => modules,
    distIndex: join(root, 'index.html'),
    shimBody: async () => new TextEncoder().encode('shim-body'),
    chromeCssBody: async () => new TextEncoder().encode('chrome-css-body'),
  })
}

describe('createProtocolHandler', () => {
  it('names a loopback authority so the client classifies the connection as loopback', () => {
    // dsh-client-connection derives `isLoopback` from `location.hostname` via
    // isLoopbackHostname; a non-loopback page binds every settings scope in
    // memory mode and the plugin configuration cards render nothing.
    expect(new URL(DESKTOP_ORIGIN).hostname).toBe('localhost')
  })

  it('serves the animated wordmark splash on the index route until the host is ready', async () => {
    const serve = handler(() => ({ state: 'booting' }))
    const response = await serve(new Request('dsh://localhost/index.html'))
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('DeepSeek Harness is starting')
    // The splash keeps the page transparent (Mica shows through) and centers
    // the wordmark with the looping left-to-right light sweep.
    expect(html).toContain('background: transparent')
    expect(html).toContain('--dsw-alias-brand-primary: #4d6bfe')
    expect(html).toContain('class="sweep"')
    expect(html).toContain('@keyframes sweep')
  })

  it('injects the boot manifest, the shim tag, and the desktop chrome link into the settled index', async () => {
    const serve = handler(() => ({ state: 'ready' }))
    const response = await serve(new Request('dsh://localhost/index.html'))
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain('window.__DSH_BOOT__ = {"rev":"rev1"')
    expect(html).toContain('<script src="dsh://localhost/shim.js"></script>')
    expect(html).toContain('<link rel="stylesheet" href="dsh://localhost/desktop-chrome.css" />')
    expect(html).toContain('<div id="root"></div>')
  })

  it('serves the shim bundle', async () => {
    const serve = handler(() => ({ state: 'ready' }))
    const response = await serve(new Request('dsh://localhost/shim.js'))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('shim-body')
  })

  it('serves the desktop chrome stylesheet', async () => {
    const serve = handler(() => ({ state: 'ready' }))
    const response = await serve(new Request('dsh://localhost/desktop-chrome.css'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await response.text()).toBe('chrome-css-body')
  })

  it('serves a registered plugin client bundle and its source map', async () => {
    writeFileSync(join(root, 'plugin-client.js'), 'module.exports = {}\n')
    writeFileSync(join(root, 'plugin-client.js.map'), '{"version":3}\n')
    const serve = handler(() => ({ state: 'ready' }))
    const bundle = await serve(new Request('dsh://localhost/plugins/@fixture/plugin/client.js?rev=rev1'))
    expect(bundle.status).toBe(200)
    expect(bundle.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await bundle.text()).toBe('module.exports = {}\n')
    const map = await serve(new Request('dsh://localhost/plugins/@fixture/plugin/client.js.map'))
    expect(map.status).toBe(200)
    expect(map.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await map.text()).toBe('{"version":3}\n')
  })

  it('answers 404 for an unregistered plugin bundle', async () => {
    const serve = handler(() => ({ state: 'ready' }))
    const response = await serve(new Request('dsh://localhost/plugins/@fixture/unknown/client.js'))
    expect(response.status).toBe(404)
  })

  it('serves dist assets with their mime types', async () => {
    const serve = handler(() => ({ state: 'ready' }))
    const js = await serve(new Request('dsh://localhost/assets/app.js'))
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    const font = await serve(new Request('dsh://localhost/assets/font.woff2'))
    expect(font.status).toBe(200)
    expect(font.headers.get('content-type')).toBe('font/woff2')
  })

  it('serves one byte range for media probes', async () => {
    const serve = handler(() => ({ state: 'ready' }))
    const response = await serve(new Request('dsh://localhost/assets/font.woff2', {
      headers: { range: 'bytes=2-5' },
    }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 2-5/11')
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('FF2-')
  })

  it('rejects traversal outside the dist root', async () => {
    // WHATWG URLs normalize dot segments before the handler sees a path, so
    // the guard is exercised directly with a hostile decoded pathname.
    const response = await serveDistAsset('/../../package.json', new Request('dsh://localhost/'), root, join(root, 'index.html'))
    expect(response.status).toBe(403)
  })

  it('answers 404 for a missing asset (no SPA fallback on the desktop)', async () => {
    const serve = handler(() => ({ state: 'ready' }))
    const response = await serve(new Request('dsh://localhost/assets/missing.js'))
    expect(response.status).toBe(404)
  })

  it('rejects non-GET/HEAD methods', async () => {
    const serve = handler(() => ({ state: 'ready' }))
    const response = await serve(new Request('dsh://localhost/index.html', { method: 'POST' }))
    expect(response.status).toBe(405)
  })
})
