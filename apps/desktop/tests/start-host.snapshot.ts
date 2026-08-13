/**
 * Keyless desktop boot snapshot: boots the real desktop composition
 * (base + web-app bundles, HTTP transport stripped, IPC transport mounted)
 * in-process under a hermetic home, asserts the readiness transcript and the
 * transport-strip invariants, and round-trips one real unary call through the
 * IPC carrier's dispatch. No Electron and no API key: the lane requires built
 * client bundles (run `pnpm run build` first), which the modules node half
 * reads through each package's `./client` export.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-client-modules'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startHost, NAME } from '../src/start-host.ts'
import { READY_LINE } from '../src/transport.ts'

let home: string
let savedHome: string | undefined
let savedTelemetry: string | undefined

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-desktop-snapshot-'))
  savedHome = process.env.DSH_HOME
  savedTelemetry = process.env.DSH_TELEMETRY_DISABLED
  process.env.DSH_HOME = home
  process.env.DSH_TELEMETRY_DISABLED = '1'
})

afterAll(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  if (savedTelemetry === undefined) delete process.env.DSH_TELEMETRY_DISABLED
  else process.env.DSH_TELEMETRY_DISABLED = savedTelemetry
  rmSync(home, { recursive: true, force: true })
})

describe('desktop host assembly', () => {
  it('boots the stripped Web surface over the IPC transport and serves a unary call', { timeout: 180_000 }, async () => {
    const transcript: string[] = []
    const started = await startHost({
      workspaceRoot: home,
      home,
      installProcessGuards: false,
      log: (line) => { transcript.push(line) },
    })
    try {
      expect(transcript).toEqual([READY_LINE])
      // The transport-strip invariants: zero HTTP server, the real connection
      // host service present for the gateway interceptor, the native picker.
      expect(started.ctx.get('webServer')).toBeUndefined()
      expect(started.ctx.get('connection')).toBeDefined()
      expect((started.ctx.get('directoryPicker') as { capability(): { kind: string } } | undefined)?.capability().kind)
        .toBe('native')

      const graphEntries = started.ctx.clientModules.graph().entries
      expect(graphEntries.length).toBeGreaterThan(0)

      // One real round-trip through the same dispatch the IPC relay uses.
      const response = await started.transport.fetch(new Request('http://dsh.internal/api/session.list', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'snapshot-1', method: 'session.list', payload: {} }),
      }))
      expect(response.status).toBe(200)
      const envelope = await response.json() as { result: { ok: boolean; value: { items: unknown[] } } }
      expect(envelope.result.ok).toBe(true)
      expect(envelope.result.value.items).toEqual([])

      expect({
        boot: NAME,
        readyLine: transcript,
        graphIds: graphEntries.map(entry => entry.id).sort(),
        sessionList: envelope.result.value,
      }).toMatchSnapshot()
    } finally {
      await started.shutdown.shutdown()
    }
  })
})
