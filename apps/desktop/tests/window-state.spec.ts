/** Persisted window geometry: defaults, clamping, and best-effort writes. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clampWindowState, DEFAULT_WINDOW_STATE, readWindowState, writeWindowState } from '../src/window-state.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-window-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readWindowState', () => {
  it('returns the default when the file is missing', () => {
    expect(readWindowState(join(dir, 'missing.json'))).toEqual(DEFAULT_WINDOW_STATE)
  })

  it('returns the default when the file is malformed', () => {
    writeFileSync(join(dir, 'state.json'), 'not json')
    expect(readWindowState(join(dir, 'state.json'))).toEqual(DEFAULT_WINDOW_STATE)
  })

  it('reads a persisted state and drops non-finite fields', () => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ width: 900, height: 600, x: 12, y: 'nope', maximized: true }))
    expect(readWindowState(join(dir, 'state.json'))).toEqual({ width: 900, height: 600, x: 12, maximized: true })
  })
})

describe('clampWindowState', () => {
  it('shrinks oversized windows to the work area', () => {
    expect(clampWindowState({ width: 4000, height: 3000 }, { width: 1920, height: 1080 }))
      .toEqual({ width: 1920, height: 1080 })
  })

  it('keeps the title bar reachable after a display change', () => {
    expect(clampWindowState({ width: 800, height: 600, x: -5000, y: 5000 }, { width: 1920, height: 1080 }))
      .toEqual({ width: 800, height: 600, x: -400, y: 780 })
  })

  it('preserves the maximized mark', () => {
    expect(clampWindowState({ width: 800, height: 600, maximized: true }, { width: 1920, height: 1080 }).maximized).toBe(true)
  })
})

describe('writeWindowState', () => {
  it('round-trips through the file', () => {
    const state = { width: 1024, height: 768, x: 40, y: 24, maximized: false }
    writeWindowState(join(dir, 'state.json'), state)
    expect(readWindowState(join(dir, 'state.json'))).toEqual(state)
  })

  it('keeps a trailing newline like every committed file', () => {
    writeWindowState(join(dir, 'state.json'), DEFAULT_WINDOW_STATE)
    expect(readFileSync(join(dir, 'state.json'), 'utf8').endsWith('\n')).toBe(true)
  })
})
