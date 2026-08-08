import { tauriUnavailable } from './unavailable'

function createWebviewStub() {
  return {
    setZoom: (_factor: number) => tauriUnavailable('webview.setZoom')
  }
}

export function getCurrentWebview() {
  return createWebviewStub()
}
