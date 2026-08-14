/**
 * Rasterize build/icon.svg into build/icon.png (1024x1024 RGBA) for
 * electron-builder, which derives the per-platform .ico/.icns at packaging
 * time. Runs under Electron's Chromium — the only offline SVG rasterizer this
 * app's dependency closure guarantees on every platform — instead of adding an
 * image-processing dependency for one build asset. Run: pnpm run build:icon
 *
 * A .cjs entry: Electron's default app cannot load a bare ESM file path.
 */

const { app, BrowserWindow } = require('electron')
const { readFile, writeFile } = require('node:fs/promises')
const { dirname, join } = require('node:path')

/** The icon's square raster size in device pixels. */
const SIZE = 1024
/** Root-level width/height the source SVG carries (copied verbatim from website/public/favicon.svg). */
const SOURCE_SIZE = 'width="50" height="50"'

const here = dirname(__filename)

async function main() {
  await app.whenReady()
  const svg = await readFile(join(here, 'icon.svg'), 'utf8')
  if (!svg.includes(SOURCE_SIZE)) throw new Error('icon.svg no longer carries the expected root size; update SOURCE_SIZE')
  const sized = svg.replace(SOURCE_SIZE, `width="${SIZE}" height="${SIZE}"`)
  const url = `data:image/svg+xml;base64,${Buffer.from(sized).toString('base64')}`

  // Offscreen rendering: capturePage on a never-shown window stalls on
  // Windows, while the offscreen compositor paints unconditionally.
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  })
  win.webContents.setFrameRate(60)
  await win.loadURL(url)
  const image = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('offscreen paint timed out')), 15000)
    win.webContents.once('paint', (_event, _dirty, frame) => {
      clearTimeout(timer)
      resolve(frame)
    })
  })
  const resized = image.resize({ width: SIZE, height: SIZE, quality: 'best' })
  await writeFile(join(here, 'icon.png'), resized.toPNG())
  win.destroy()
  app.exit(0)
}

main().catch((error) => {
  console.error(error)
  app.exit(1)
})
