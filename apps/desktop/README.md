# `@deepseek-ai/dsh-desktop`

English | [中文](README.zh.md)

The desktop application: an Electron shell that boots the dsh host **in-process** and reuses the existing Web client over an IPC fetch/WebSocket carrier — no HTTP server, no ports, and the same `$DSH_HOME` as `dsh web`. Opening the app starts the harness; closing it disposes the tree with a bounded graceful quit.

## What ships

- **In-process host** — [`src/start-host.ts`](src/start-host.ts) runs the profile-boot sequence for the `desktop` profile (base + web-app bundles) with the HTTP transport rows stripped by [`config/desktop.patch.yml`](config/desktop.patch.yml); the main process and the host share one process lifetime.
- **`dsh://` carrier** — [`src/protocol.ts`](src/protocol.ts) serves the built web frontend with the boot manifest, the transport shim, and the window chrome injected; [`src/relay.ts`](src/relay.ts) + [`src/shim.ts`](src/shim.ts) carry the client's `/api` fetch and WebSocket traffic over postMessage ⇄ IPC.
- **WinUI-style window** — frameless with Window Controls Overlay and Mica: caption-button colors follow the system theme, the title band is a drag region, the app surface sits on the Mica material, and leaving fullscreen restores the rounded corners.
- **Animated splash** — the wordmark centered on the Mica material with a light band sweeping across the glyphs (SVG-internal clip, no CSS fragment references) while the host boots.

## Packaging

electron-builder config lives in [`electron-builder.yml`](electron-builder.yml): NSIS installer plus a portable zip on Windows, dmg on macOS. Two constraints drive the layout:

- **The app declares its whole composition closure as direct dependencies.** The boot chain imports peer packages statically and the loader resolves every patch row's plugin from the app's `node_modules` at runtime; electron-builder ships only declared production dependencies.
- **`asar: false`.** The boot heals `$DSH_HOME/profiles/node_modules` with junctions at the app's dependency tree, and Windows junctions cannot traverse into an asar. Everything ships as real files.

The release workflow (`.github/workflows/build-desktop.yml`) builds both installers on `v*` tags and attaches them to the GitHub Release; CI has no signing identity, so installers are unsigned.

## Development

From the repository root, build once (`pnpm run build`), then run from source:

```sh
pnpm --filter @deepseek-ai/dsh-desktop run start
```

Unit tests and the keyless boot snapshot run under plain Node (no Electron):

```sh
pnpm vitest run apps/desktop/tests
```

The icon (`build/icon.png`, the DeepSeek whale mark) is regenerated with `pnpm run build:icon` from `build/icon.svg`.
