/** Persisted main-window geometry: restored on launch, saved on close. */

import { readFileSync, writeFileSync } from 'node:fs'

/** The persisted window state document. */
export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

/** The shipped default: a comfortable size the loading page and the chat surface both suit. */
export const DEFAULT_WINDOW_STATE: WindowState = { width: 1280, height: 800 }

/** Minimums below which a restored or clamped window is unusable. */
const MIN_WIDTH = 400
const MIN_HEIGHT = 300

/**
 * Read the persisted window state; a missing or malformed file yields the
 * default rather than failing the launch.
 * @param statePath - absolute path of the window-state.json file.
 * @returns the parsed state, or the default.
 */
export function readWindowState(statePath: string): WindowState {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(statePath, 'utf8')) as unknown
  } catch {
    return { ...DEFAULT_WINDOW_STATE }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_WINDOW_STATE }
  const state = parsed as Partial<WindowState>
  return {
    width: typeof state.width === 'number' && Number.isFinite(state.width) ? state.width : DEFAULT_WINDOW_STATE.width,
    height: typeof state.height === 'number' && Number.isFinite(state.height) ? state.height : DEFAULT_WINDOW_STATE.height,
    ...typeof state.x === 'number' && Number.isFinite(state.x) ? { x: state.x } : {},
    ...typeof state.y === 'number' && Number.isFinite(state.y) ? { y: state.y } : {},
    ...typeof state.maximized === 'boolean' ? { maximized: state.maximized } : {},
  }
}

/**
 * Clamp a restored window into the current display: sizes shrink to the
 * work area and positions shift so the title bar stays reachable (a display
 * layout change must not strand the window off-screen).
 * @param state - the restored state.
 * @param workArea - the primary display's work-area size.
 * @returns the clamped state.
 */
export function clampWindowState(state: WindowState, workArea: { width: number; height: number }): WindowState {
  const width = Math.max(MIN_WIDTH, Math.min(state.width, workArea.width))
  const height = Math.max(MIN_HEIGHT, Math.min(state.height, workArea.height))
  const clamped: WindowState = { width, height, ...state.maximized === true ? { maximized: true } : {} }
  if (state.x !== undefined) {
    const x = Math.min(Math.max(state.x, MIN_WIDTH - width), workArea.width - MIN_WIDTH)
    clamped.x = x
  }
  if (state.y !== undefined) {
    const y = Math.min(Math.max(state.y, 0), Math.max(0, workArea.height - MIN_HEIGHT))
    clamped.y = y
  }
  return clamped
}

/**
 * Persist the window state (best-effort: a failed write must not block the
 * window from closing).
 * @param statePath - absolute path of the window-state.json file.
 * @param state - the state to persist.
 */
export function writeWindowState(statePath: string, state: WindowState): void {
  try {
    writeFileSync(statePath, JSON.stringify(state) + '\n')
  } catch {
    // Best-effort persistence: a read-only userData directory is not a crash.
  }
}
