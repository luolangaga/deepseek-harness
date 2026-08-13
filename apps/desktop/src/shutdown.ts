/** Bounded, coalesced shutdown for the desktop shell. */

/** Maximum grace allowed for the application tree to dispose before forced quit. */
const DESKTOP_SHUTDOWN_TIMEOUT_MS = 5_000

/** Application-teardown controller owned by the desktop main process. */
export interface DesktopShutdown {
  /** Start or join graceful disposal; resolves once the tree reached quiescence (or was forced). */
  shutdown(): Promise<void>
  /** Start graceful disposal followed by forced quit, or force immediately when disposal is already running. */
  interrupt(): void
}

/**
 * Create one shutdown controller around the application disposer. Normal
 * requests coalesce; a repeated request escalates to the forced quit, and the
 * timer bounds the grace regardless (a wedged disposer must delay the quit,
 * never cancel it).
 * @param dispose - whole-application teardown that resolves at quiescence.
 * @param force - function that quits the application immediately (app.exit in main; tests inject).
 * @param complete - function recording the natural completion; tests inject.
 * @param timeoutMs - grace before forced quit, replaceable by tests.
 * @returns a controller whose normal calls coalesce and whose repeated call escalates.
 */
export function createDesktopShutdown(
  dispose: () => Promise<void>,
  force: () => void = () => {},
  complete: () => void = () => {},
  timeoutMs = DESKTOP_SHUTDOWN_TIMEOUT_MS,
): DesktopShutdown {
  let pending: Promise<void> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let completed = false
  let forced = false

  const clearExitTimeout = (): void => {
    /* v8 ignore else -- shutdown() arms the timer before any asynchronous exit path can run. */
    if (timeout !== undefined) clearTimeout(timeout)
  }

  const forceOnce = (): void => {
    if (forced) return
    forced = true
    clearExitTimeout()
    force()
  }

  const completeOnce = (): void => {
    if (completed || forced) return
    completed = true
    clearExitTimeout()
    complete()
  }

  const start = (forceAfterDispose: boolean): Promise<void> => {
    if (pending !== undefined) return pending
    timeout = setTimeout(() => { forceOnce() }, timeoutMs)
    pending = Promise.resolve().then(dispose).then(
      () => {
        if (forceAfterDispose) forceOnce()
        else completeOnce()
      },
      () => { forceOnce() },
    )
    return pending
  }

  return {
    shutdown() {
      return start(false)
    },
    interrupt() {
      if (pending !== undefined) {
        forceOnce()
        return
      }
      void start(true)
    },
  }
}
