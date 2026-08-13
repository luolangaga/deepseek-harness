/**
 * The desktop host assembly (Electron-free): the same profile-boot sequence
 * the dsh CLI launcher runs, composed for the desktop surface — the base +
 * web-app bundle layers with the HTTP transport rows stripped by this app's
 * shipped overlay (`config/desktop.patch.yml`), plus the desktop transport
 * plugin and the app-computed overlay rows (workspace root, shipped
 * agent-preset root, telemetry switch). This module never touches the
 * electron package, so the keyless boot snapshot and unit tests run under
 * plain Node.
 */

import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { createDesktopShutdown, type DesktopShutdown } from './shutdown.ts'
import { DesktopTransport } from './transport.ts'

/** Diagnostic prefix shared by every boot error and patch warning this app emits. */
export const NAME = 'dsh-desktop'

/** The profile name the desktop app boots (shipped template: base + web-app bundles). */
const PROFILE_NAME = 'desktop'

/** Absolute path of this installation's package.json (both anchors: src/ and lib/ sit one level under apps/desktop). */
const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The shipped desktop overlay: strips the Web HTTP transport and pins the native directory picker. */
const SHIPPED_DESKTOP_PATCH = fileURLToPath(new URL('../config/desktop.patch.yml', import.meta.url))

/** Root config filename inside the profile directory (the boot include's anchor). */
const PROFILE_ROOT_FILENAME = 'cordis.yml'

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** The empty root entry list every profile tree patches over (the same text the CLI launcher writes). */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then the profile's own
# cordis.patch.yml, then app-shipped overlays. Edit cordis.patch.yml, not this file.
[]
`

/** The shipped agent-preset root: the CLI product publishes its `config/` beside its package. */
function shippedPresetRoot(): string {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'config', 'agent-presets')
}

/** Options for {@link startHost}. */
export interface StartHostOptions {
  /** The default sandbox workspace root (dev cwd, packaged home dir). */
  workspaceRoot: string
  /** The Harness home; defaults to {@link resolveDshHome}. */
  home?: string
  /** Readiness-line sink; defaults to console.log. */
  log?: (line: string) => void
  /** Bounded-shutdown force callback (app.exit in main); tests inject. */
  forceQuit?: () => void
  /**
   * Install the process-level fail-loud rejection guard. The Electron main
   * keeps it; in-process tests that share the vitest process pass false.
   */
  installProcessGuards?: boolean
}

/** The booted desktop host: the settled tree plus its teardown controller. */
export interface StartHostResult {
  /** The settled root context (apiProxy, clientModules, connection all live). */
  ctx: Context
  /** The desktop transport (IPC relay dispatch + downlink pumps). */
  transport: DesktopTransport
  /** Coalesced, bounded application shutdown over the tree disposal. */
  shutdown: DesktopShutdown
}

/**
 * Boot the desktop composition end to end and leave process lifetime to the
 * Electron main. The patch order mirrors the CLI launcher: bundle layers, the
 * profile's own patch, the home-level patch, then this app's shipped overlay
 * and computed rows — a user edit can never displace the transport strip.
 * @param options - workspace root, home, sinks, and guard switches.
 * @returns the settled tree, its transport, and the shutdown controller.
 */
export async function startHost(options: StartHostOptions): Promise<StartHostResult> {
  const environment = loadLayeredEnv(NAME)
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const home = options.home ?? resolveDshHome()
  const profile = loadProfile(NAME, PROFILE_NAME, INSTALL_ANCHOR, home)
  // The root is always rewritten: the whole composition is patch layers, and
  // the vendored Loader's tree write-back can bake composed rows into the
  // file — which would duplicate every bundle insert on the next boot.
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)

  const homePatches = loadOptionalPatches(NAME, join(home, PROFILE_PATCH_FILENAME)) ?? []
  const overlayPatches = loadOverlayPatches(NAME, SHIPPED_DESKTOP_PATCH)
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlayPatches])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }

  const overlays: PatchOptions[] = [...overlayPatches]
  // The shipped preset root is the part of the roster only this app can
  // resolve; the writable root the roster appends is dsh-agent-presets' own.
  if (rows.has('agent-presets')) {
    overlays.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
        roots: [{ path: shippedPresetRoot(), trust: 'system' }],
      },
    })
  }
  // The base row pins workspaceRoot to process.cwd(), which for a packaged
  // app launched from Explorer is the install directory. The desktop pins its
  // own default instead (see main.ts); the per-session directory picker
  // remains the user's real workspace choice.
  if (rows.has('sandbox-policy')) {
    overlays.push({
      id: 'sandbox-policy',
      config: {
        ...(rows.get('sandbox-policy')?.config ?? {}) as Record<string, unknown>,
        workspaceRoot: options.workspaceRoot,
      },
    })
  }
  if ((process.env.DSH_TELEMETRY_DISABLED ?? '') !== '' && rows.has(TELEMETRY_ROW_ID)) {
    overlays.push({ id: TELEMETRY_ROW_ID, disabled: true })
  }

  const patches: PatchOptions[] = [...bundlePatches, ...profile.patches, ...homePatches, ...overlays]
  const app: { current?: Context } = {}
  const shutdown = createDesktopShutdown(
    async () => { await app.current?.fiber.dispose() },
    options.forceQuit,
  )
  if (options.installProcessGuards ?? true) {
    installFailLoud(NAME, process, async () => {
      await app.current?.fiber.dispose()
    })
  }
  const ctx = await boot(
    NAME,
    join(profile.dir, PROFILE_ROOT_FILENAME),
    patches,
    (hostCtx) => {
      app.current = hostCtx
      // Before any config-tree entry mounts, so plugins resolve all
      // launch-time environment values from the same immutable snapshot.
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
      // An embedding host has no command line; the exit request still routes
      // appExit consumers to the bounded shutdown.
      provideCmdline(hostCtx, { args: [], exit: () => { shutdown.interrupt() } })
      // The IPC carrier is the app's own assembly (the GUI-layering note's
      // "a mixture never becomes a package"), mounted before the tree so the
      // api-gateway row's `connection` inject resolves.
      hostCtx.plugin({
        name: 'desktop-transport',
        inject: [],
        apply: (transportCtx) => {
          new DesktopTransport(transportCtx, {
            printReady: true,
            ...options.log === undefined ? {} : { log: options.log },
          })
        },
      })
    },
  )
  app.current = ctx
  const transport = ctx.get('desktopTransport')
  if (transport === undefined) {
    // The transport mounts in prepare before any tree entry; reaching here
    // means the mount itself failed, which boot's activation audit reports.
    throw new Error(`${NAME}: desktop transport service missing after settled boot`)
  }
  return { ctx, transport, shutdown }
}
