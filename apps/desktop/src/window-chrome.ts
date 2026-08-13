/**
 * WinUI-style window chrome for the desktop shell: marks the title-band drag
 * regions at runtime. CSS positional selectors cannot do this job — the slot
 * renderer wraps every column in `display: contents` anchors, so nth-child
 * chains resolve to invisible wrappers (and one wrong step turns a whole
 * column into a drag region that swallows clicks). This script walks the
 * real layout children instead and stamps stable data attributes the
 * desktop-chrome.css stylesheet owns.
 */

/** Interactive elements exempted from a drag region (clicks keep working). */
const NO_DRAG_SELECTOR = [
  'button', 'a', 'input', 'select', 'textarea', 'summary',
  '[role="button"]', '[role="tab"]', '[role="tablist"]', '[role="tree"]',
  '[role="treeitem"]', '[role="menuitem"]', '[role="option"]', '[role="listbox"]',
  '[contenteditable="true"]',
].join(', ')

/** The attribute a drag region carries (styled by desktop-chrome.css). */
export const DRAG_REGION_ATTR = 'data-dsh-drag-region'

/** The attribute every interactive element inside a drag region carries. */
export const NO_DRAG_ATTR = 'data-dsh-no-drag'

/** Element id of the injected drag strip covering the title band over the center and details columns. */
export const DRAG_STRIP_ID = 'dsh-drag-strip'

/** First child that participates in layout (slot anchors are `display: contents`; descend through them). */
function firstLayoutChild(el: Element): Element | null {
  for (const child of el.children) {
    if (getComputedStyle(child).display !== 'contents') return child
    const nested = firstLayoutChild(child)
    if (nested !== null) return nested
  }
  return null
}

/** The last-marked logo row (the shim is a page singleton; re-found only when replaced). */
let cachedLogoRow: Element | null = null

/**
 * Mark the window-chrome regions on the settled frame: the sidebar's logo
 * row is a drag region, and a transparent strip covers the rest of the title
 * band (center + details columns) so the whole empty band drags the window.
 * The strip starts at the sidebar's right edge (the logo row owns that part)
 * and ends at the caption-button overlay. Runs on every frame mutation; the
 * cached elements make the hot path cheap.
 * @param doc - the page document.
 */
export function applyWindowChrome(doc: Document): void {
  const frame = doc.querySelector('[data-app-frame]')
  if (frame === null) return
  if (cachedLogoRow?.isConnected !== true) {
    const sidebarCol = frame.children[0]
    const sidebarRoot = sidebarCol === undefined ? null : firstLayoutChild(sidebarCol)
    cachedLogoRow = sidebarRoot === null ? null : firstLayoutChild(sidebarRoot)
    if (cachedLogoRow !== null) {
      cachedLogoRow.setAttribute(DRAG_REGION_ATTR, '')
      for (const interactive of cachedLogoRow.querySelectorAll(NO_DRAG_SELECTOR)) {
        interactive.setAttribute(NO_DRAG_ATTR, '')
      }
    }
  }
  let strip = doc.getElementById(DRAG_STRIP_ID)
  if (strip === null) {
    strip = doc.createElement('div')
    strip.id = DRAG_STRIP_ID
    strip.setAttribute(DRAG_REGION_ATTR, '')
    doc.body.append(strip)
  }
  const sidebarWidth = frame.children[0]?.getBoundingClientRect().width ?? 0
  strip.style.left = `${String(sidebarWidth)}px`
}

/**
 * Install the chrome marker: apply now (once the body exists — the injected
 * script runs before it) and re-apply on frame mutations until the shell
 * settles (the frame mounts after the loading page).
 * @param doc - the page document.
 */
export function installWindowChrome(doc: Document): void {
  const start = (): void => {
    applyWindowChrome(doc)
    const observer = new MutationObserver(() => {
      applyWindowChrome(doc)
    })
    observer.observe(doc.body, { childList: true, subtree: true })
  }
  // The injected script runs in <head>, before the body exists: wait for the
  // document when the parser is still running.
  if (doc.readyState !== 'loading') start()
  else doc.addEventListener('DOMContentLoaded', start, { once: true })
}
