/**
 * Electron main process for the desktop app: registers the dsh:// scheme,
 * boots the harness host in-process (startHost, in parallel with Electron's
 * own init), serves the splash until the tree settles, and wires the IPC
 * relay, window lifecycle, menu, and bounded shutdown. Everything dsh-shaped
 * lives in startHost/transport/protocol/relay; this file is the thin
 * Electron shell.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  screen,
  shell,
} from 'electron'
import type {} from '@deepseek-ai/dsh-client-modules'
import { createProtocolHandler, resolveDistIndex, DESKTOP_ORIGIN, type BootState } from './protocol.ts'
import { DesktopRelay } from './relay.ts'
import { startHost, type StartHostResult } from './start-host.ts'
import { clampWindowState, readWindowState, writeWindowState } from './window-state.ts'

/** The custom scheme the renderer loads from (standard + secure, no fetch API support of its own). */
const SCHEME = 'dsh'

/** Windows taskbar/notification identity. */
const APP_USER_MODEL_ID = 'com.deepseek.harness.desktop'

/** The sandboxed preload bundle, emitted beside lib/main.js by build/assets.mjs. */
const PRELOAD_PATH = fileURLToPath(new URL('../lib/preload.cjs', import.meta.url))

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false } },
])

/** The settled host, published by the boot promise. */
let bootedHost: StartHostResult | undefined

/** The main window (recreated on macOS activate). */
let mainWindow: BrowserWindow | null = null

// A second launch focuses the running instance; the backend belongs to that process.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void run()
}

/** The application body: boot the host in parallel with Electron init, then open the window. */
async function run(): Promise<void> {
  app.setAppUserModelId(APP_USER_MODEL_ID)

  let bootState: BootState = { state: 'booting' }
  const hostPromise = startHost({
    // The sandbox default: the checkout's cwd during development, the user's
    // home directory once packaged (an Explorer launch must not pin the
    // workspace to the install directory).
    workspaceRoot: app.isPackaged ? homedir() : process.cwd(),
    forceQuit: () => { app.exit(0) },
  })
  void hostPromise.then(
    (host) => {
      bootedHost = host
      bootState = { state: 'ready' }
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        void mainWindow.loadURL(`${DESKTOP_ORIGIN}/index.html`)
      }
    },
    (error: unknown) => {
      bootState = { state: 'error', message: error instanceof Error ? error.message : String(error) }
      console.error(error)
    },
  )

  await app.whenReady()

  installMenu()
  protocol.handle(SCHEME, createProtocolHandler({
    status: getBootState,
    modules: () => {
      const host = bootedHost
      if (host === undefined) return undefined
      return {
        graph: () => host.ctx.clientModules.graph(),
        clientPath: id => host.ctx.clientModules.clientPath(id),
      }
    },
    distIndex: resolveDistIndex(),
  }))

  const bootStatus = getBootState()
  if (bootStatus.state === 'error') {
    // Fail loud: a boot failure before any window opened ends the run with a
    // visible report instead of a silent exit.
    dialog.showErrorBox('DeepSeek Harness failed to start', bootStatus.message)
    app.exit(1)
    return
  }

  /** The boot-state accessor: closures reassign the variable, so the read must not carry stale flow narrowing. */
  function getBootState(): BootState {
    return bootState
  }

  let quitting = false

  /** One bounded graceful teardown: dispose the tree, then let the quit proceed; a second request forces. */
  function quitGracefully(): void {
    if (quitting) {
      bootedHost?.shutdown.interrupt()
      return
    }
    quitting = true
    void (async () => {
      if (bootedHost !== undefined) await bootedHost.shutdown.shutdown()
      app.quit()
    })()
  }

  createWindow()

  app.on('second-instance', () => {
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return
    quitGracefully()
  })
  app.on('activate', () => {
    if (mainWindow === null) createWindow()
  })
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitGracefully()
  })
}

/** Create the main window on the splash page (the settled index replaces it once the host is ready). */
function createWindow(): BrowserWindow {
  const statePath = join(app.getPath('userData'), 'window-state.json')
  const state = clampWindowState(readWindowState(statePath), screen.getPrimaryDisplay().workAreaSize)
  // The native caption buttons follow the system theme, not the app theme.
  const overlayColors = (): { color: string; symbolColor: string } => nativeTheme.shouldUseDarkColors
    ? { color: '#10101480', symbolColor: '#e8e8ea' }
    : { color: '#f4f4f480', symbolColor: '#1a1a1c' }
  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...state.x !== undefined ? { x: state.x } : {},
    ...state.y !== undefined ? { y: state.y } : {},
    show: false,
    backgroundColor: '#101014',
    title: 'DeepSeek Harness',
    // WinUI-style chrome: no OS title bar, native caption buttons floating
    // over the content's top-right (Window Controls Overlay), and the Mica
    // window material behind the transparent title band (Windows 11; other
    // platforms fall back to the backgroundColor above).
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      ...overlayColors(),
      height: 48,
    },
    backgroundMaterial: 'mica',
    webPreferences: {
      preload: PRELOAD_PATH,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  nativeTheme.on('updated', () => {
    if (!win.isDestroyed()) win.setTitleBarOverlay({ ...overlayColors(), height: 48 })
  })
  // DWM drops the rounded corners of a frameless Mica window when it returns
  // from fullscreen; re-applying the material makes DWM re-round them. No
  // 'none' detour: the opaque fallback would flash and kill the OS
  // fullscreen-transition animation.
  win.on('leave-full-screen', () => {
    setImmediate(() => {
      if (!win.isDestroyed()) win.setBackgroundMaterial('mica')
    })
  })
  if (state.maximized === true) win.maximize()
  // The splash paints fast and reads as instant; show on first paint rather
  // than waiting for the backend (which the splash page does not need).
  win.once('ready-to-show', () => { win.show() })
  win.on('close', () => {
    const bounds = win.getNormalBounds()
    writeWindowState(statePath, {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: win.isMaximized(),
    })
  })
  // The renderer is this app's own surface: new windows are denied and
  // http(s) targets open in the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${DESKTOP_ORIGIN}/`) && url !== 'about:blank') event.preventDefault()
  })
  win.on('closed', () => { mainWindow = null })
  void win.loadURL(`${DESKTOP_ORIGIN}/index.html`)
  attachRelay(win)
  mainWindow = win
  return win
}

/** Attach one page to its own relay: every subscription dies with the page. */
function attachRelay(win: BrowserWindow): void {
  const relay = new DesktopRelay({
    fetch: (request) => {
      const host = bootedHost
      if (host === undefined) return Promise.resolve(new Response('host not ready', { status: 503 }))
      return host.transport.fetch(request)
    },
    openStream: (kind, sink) => {
      const host = bootedHost
      if (host === undefined) return { dispose: () => {}, done: Promise.resolve() }
      return host.transport.openStream(kind, sink)
    },
  })
  relay.attach({
    send: (payload) => {
      if (!win.isDestroyed()) win.webContents.send('dsh:relay', payload)
    },
    onRequest: (handler) => {
      const wrapped = (event: Electron.IpcMainEvent, payload: unknown): void => {
        if (event.sender === win.webContents) handler(payload)
      }
      ipcMain.on('dsh:relay', wrapped)
      return () => { ipcMain.removeListener('dsh:relay', wrapped) }
    },
    onNavigate: (handler) => {
      win.webContents.on('did-start-navigation', handler)
      win.webContents.once('destroyed', handler)
      return () => {
        if (!win.isDestroyed()) win.webContents.removeListener('did-start-navigation', handler)
      }
    },
  })
}

/** Standard menu: the Edit roles keep clipboard shortcuts working, which a bare Electron window lacks. */
function installMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as Electron.MenuItemConstructorOptions] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
