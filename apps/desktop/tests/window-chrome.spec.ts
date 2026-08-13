/** The window-chrome marker: the top-left drag patch plus the injected band strip. */
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  applyWindowChrome,
  DRAG_REGION_ATTR,
  DRAG_STRIP_ID,
  NO_DRAG_ATTR,
} from '../src/window-chrome.ts'

/** The settled frame with the slot renderer's display:contents anchors in place. */
function buildDom(): Document {
  document.body.innerHTML = `
    <div data-app-frame="">
      <div>
        <div style="display: contents">
          <div>
            <div>
              <button type="button">brand</button>
            </div>
            <div>workspace area</div>
          </div>
        </div>
      </div>
      <div>
        <div data-phase="active">
          <div style="display: contents">
            <header>
              <button type="button">session log download</button>
            </header>
          </div>
        </div>
      </div>
    </div>`
  return document
}

describe('applyWindowChrome', () => {
  it('marks the sidebar logo row and the injected strip as the drag regions', () => {
    const doc = buildDom()
    applyWindowChrome(doc)
    const dragRegions = [...doc.querySelectorAll(`[${DRAG_REGION_ATTR}]`)]
    expect(dragRegions).toHaveLength(2)
    expect(dragRegions[0]?.textContent).toContain('brand')
    expect(dragRegions[1]?.id).toBe(DRAG_STRIP_ID)
    expect(doc.querySelector('header')?.hasAttribute(DRAG_REGION_ATTR)).toBe(false)
  })

  it('exempts interactive descendants so clicks keep working', () => {
    const doc = buildDom()
    applyWindowChrome(doc)
    const exempt = [...doc.querySelectorAll(`[${NO_DRAG_ATTR}]`)]
    expect(exempt.map(el => el.tagName)).toEqual(['BUTTON'])
    expect(exempt[0]?.textContent).toContain('brand')
  })

  it('leaves the workspace area outside the drag region untouched', () => {
    const doc = buildDom()
    applyWindowChrome(doc)
    const workspaceArea = [...doc.body.querySelectorAll('div')].find(el => el.textContent === 'workspace area')
    expect(workspaceArea?.hasAttribute(DRAG_REGION_ATTR)).toBe(false)
    expect(workspaceArea?.parentElement?.hasAttribute(DRAG_REGION_ATTR)).toBe(false)
  })

  it('injects one drag strip over the title band, starting at the sidebar edge', () => {
    const doc = buildDom()
    applyWindowChrome(doc)
    const strips = doc.querySelectorAll(`#${DRAG_STRIP_ID}`)
    expect(strips).toHaveLength(1)
    const strip = strips[0]
    expect(strip?.hasAttribute(DRAG_REGION_ATTR)).toBe(true)
    expect(strip?.getAttribute('style')).toContain('left:')
    // The strip is a real element appended to the body, not a column child.
    expect(strip?.parentElement).toBe(doc.body)
  })

  it('re-runs cleanly on session switches (idempotent attribute stamping)', () => {
    const doc = buildDom()
    applyWindowChrome(doc)
    applyWindowChrome(doc)
    expect(doc.querySelectorAll(`[${DRAG_REGION_ATTR}]`)).toHaveLength(2)
    expect(doc.querySelectorAll(`#${DRAG_STRIP_ID}`)).toHaveLength(1)
  })
})
