/** Bounded shutdown semantics: coalescing, escalation, and the grace timer. */

import { describe, expect, it, vi } from 'vitest'
import { createDesktopShutdown } from '../src/shutdown.ts'

describe('createDesktopShutdown', () => {
  it('runs the disposer once and completes naturally on a normal shutdown', async () => {
    const dispose = vi.fn(async () => {})
    const force = vi.fn()
    const complete = vi.fn()
    const shutdown = createDesktopShutdown(dispose, force, complete, 50)
    await Promise.all([shutdown.shutdown(), shutdown.shutdown()])
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(force).not.toHaveBeenCalled()
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('escalates to forced quit when a second request arrives during disposal', async () => {
    let release!: () => void
    const dispose = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const force = vi.fn()
    const shutdown = createDesktopShutdown(dispose, force, () => {}, 500)
    const first = shutdown.shutdown()
    shutdown.interrupt()
    expect(force).toHaveBeenCalledTimes(1)
    // The disposer itself starts on a microtask; settle it before releasing.
    await Promise.resolve()
    release()
    await first
  })

  it('forces quit when the disposer outlives the grace timer', async () => {
    const dispose = vi.fn(() => new Promise<void>(() => {}))
    const force = vi.fn()
    const shutdown = createDesktopShutdown(dispose, force, () => {}, 20)
    // Never awaited on purpose: the never-settling disposer only ends via the forced quit.
    void shutdown.shutdown()
    await vi.waitFor(() => { expect(force).toHaveBeenCalledTimes(1) })
  })

  it('forces quit when the disposer rejects', async () => {
    const dispose = vi.fn(async () => { throw new Error('teardown failed') })
    const force = vi.fn()
    const shutdown = createDesktopShutdown(dispose, force, () => {}, 500)
    await shutdown.shutdown()
    expect(force).toHaveBeenCalledTimes(1)
  })
})
