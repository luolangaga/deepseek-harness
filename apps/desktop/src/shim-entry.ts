/**
 * The shim's production entry: the injected classic script installs the
 * transport impersonation and the window-chrome drag markers on the real
 * window as soon as it executes (before the deferred app bundle). Tests
 * import shim.ts / window-chrome.ts directly and drive fake windows instead.
 */

import { installTransportShim } from './shim.ts'
import { installWindowChrome } from './window-chrome.ts'

if (typeof window !== 'undefined') {
  installTransportShim(window)
  installWindowChrome(window.document)
}
