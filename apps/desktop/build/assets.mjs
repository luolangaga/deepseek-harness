/**
 * Electron-shaped asset builds for the desktop app: the sandboxed preload
 * (CJS — Electron sandboxed preloads cannot load ESM) and the renderer
 * transport shim (an IIFE classic script injected into the served index).
 * The main process bundle comes from tsdown; these two artifacts are the
 * parts no shared pipeline emits.
 */

import { build } from 'esbuild'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

await Promise.all([
  build({
    entryPoints: [join(root, 'src/preload.ts')],
    outfile: join(root, 'lib/preload.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    logLevel: 'info',
  }),
  build({
    entryPoints: [join(root, 'src/shim-entry.ts')],
    outfile: join(root, 'lib/shim.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    logLevel: 'info',
  }),
  build({
    entryPoints: [join(root, 'src/desktop-chrome.css')],
    outfile: join(root, 'lib/desktop-chrome.css'),
    bundle: true,
    minify: true,
    logLevel: 'info',
  }),
])
