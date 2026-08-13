/**
 * Sandboxed preload (built as CJS by build/assets.mjs): the IPC half of the
 * two-hop relay. The page's transport shim lives in the main world and cannot
 * reach ipcRenderer, so this preload forwards shim requests to the main
 * relay over the 'dsh:relay' channel and relays every main-side message back
 * through window.postMessage. Payloads stay serializable in both directions.
 */

import { ipcRenderer } from 'electron'

window.addEventListener('message', (event) => {
  const data = event.data as { source?: string; payload?: unknown } | null
  if (data?.source !== 'dsh-shim') return
  ipcRenderer.send('dsh:relay', data.payload)
})

ipcRenderer.on('dsh:relay', (_event, payload: unknown) => {
  window.postMessage({ source: 'dsh-preload', payload }, '*')
})
