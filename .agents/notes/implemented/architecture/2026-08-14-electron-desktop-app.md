# Agent Note: The Electron desktop app — in-process host, dsh:// carrier, and what packaged shipping demands

Status: implemented

English | [中文](2026-08-14-electron-desktop-app.zh.md)

## Problem

DeepSeek Harness shipped a web client only: the user must start the backend, find the port, and open a browser. The desktop client must manage the backend itself — open the app and the harness is up, close it and the process exits cleanly — and must feel native. The GUI-layering note (2026-07-19) already fixed the architecture: the Electron main process IS the host process, and "a new application needs zero new packages" — the assembly lives in the app, reusing the existing bundles, gateway, and client.

## Decision

**The host runs in-process, and the renderer is the existing web client carried over a custom scheme.** `startHost` runs the same profile-boot sequence the CLI uses (desktop profile = base + web-app bundles, desktop patch overlay stripping the HTTP transport), then serves the built web dist over a `dsh://` protocol handler. The client's `fetch`/`WebSocket` for `/api` paths are replaced by a shim that relays over `postMessage` ⇄ preload ⇄ IPC to a main-process transport dispatching through the same `createSharedFetchHandler`/downlink pumps the web carrier uses. No HTTP server, no ports; `$DSH_HOME` is shared with `dsh web`.

**The page authority must be loopback-classified.** The client derives `connection.isLoopback` from `location.hostname`, and non-loopback pages bind every settings scope memory-mode (the plugin configuration cards render nothing). `dsh://localhost` earns the same classification the web client gets from `http://localhost`.

**The packaged app declares its whole composition closure as direct dependencies.** electron-builder ships only the app's declared production closure. The boot chain statically imports peer packages (`cordis-plugin-group`, the capability peers), and the loader resolves every patch row's plugin name from the app's node_modules at runtime. Both sets must be direct dependencies — pnpm then installs their peers, and the closure scan (static `@deepseek-ai` imports over the packaged graph plus patch row names) must report zero gaps.

**The app ships unpacked (`asar: false`).** The boot heals `$DSH_HOME/profiles/node_modules` with junctions at the app's dependency tree so the loader can resolve rows from the profile root. Windows junctions cannot traverse into an asar (a file), so with asar packaging every loader entry failed and the splash hung. Unpacked, all paths are real files. Verified by booting the exact packaged closure from a simulated unpacked layout before re-tagging.

**WinUI-style window shell.** Frameless `titleBarStyle: hidden` with Window Controls Overlay and Mica; caption-button colors follow `nativeTheme` via `setTitleBarOverlay`; the title band is a drag region stamped by an injected script (CSS positional selectors cannot — the slot renderer wraps columns in `display: contents` anchors); leaving fullscreen re-applies the material so DWM re-rounds the corners; the splash sweep is clipped to the wordmark with an SVG-internal `clipPath` (no CSS `url()` references, which are unreliable in injected documents).

**Release via a tag-triggered workflow.** Pushing a `v*` tag builds macOS dmg + Windows NSIS on hosted runners and attaches both to the GitHub Release. `@electron/get` is pinned `^3.1.0` by a pnpm override: electron-builder 26.15 reads `ElectronDownloadCacheMode` from it, and the lockfile otherwise settled on 3.0.0, crashing every packaging run.

## Consequences

The desktop app boots keyless in a snapshot test (`apps/desktop/tests/start-host.snapshot.ts`) and 51 unit tests cover transport, protocol, relay, shim, shutdown, window state, and chrome. Installers are unsigned (CI has no identity; `CSC_IDENTITY_AUTO_DISCOVERY=false`), and the splash/UI work is verified on real installs before each tag. Local Windows packaging needs `ELECTRON_MIRROR` on networks where GitHub release downloads are blocked; hosted runners download directly. The `dsh://localhost` origin and the drag-band/chrome CSS are desktop-only — the web client and `dsh web` behavior are unchanged.

## Alternatives considered

- **Child-process host** — rejected by the layering note: cold start, port allocation, and a second `$DSH_HOME` lock domain; the in-process host is the design's point.
- **`asar` with `asarUnpack: node_modules/**`** — the unpacked files exist, but the heal junctions resolve through `require` to `app.asar` paths, and a Windows junction to a path inside a file is broken at the OS level before Electron's asar redirect can apply.
- **CSS `mask: url(#id)` sweep** — the light clipped to content must not depend on CSS-level fragment references inside the injected splash; an SVG-internal `clipPath` + `use` (the same mechanism the whale mark's own clip uses) is robust.
- **`dsh://app` page authority** — renders the settings scopes memory-mode and the plugin configuration page empty; loopback authority is required.
