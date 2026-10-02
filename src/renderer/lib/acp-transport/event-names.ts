/**
 * Event name translation between the two surfaces: the store uses `acp:*`
 * names; the WS protocol uses prefix-dropped types — translated here.
 */

export function toWsEventType(tauriEventName: string): string {
  return tauriEventName.startsWith('acp:') ? tauriEventName.slice(4) : tauriEventName
}

export function toTauriEventName(wsType: string): string {
  return wsType.startsWith('acp:') ? wsType : `acp:${wsType}`
}
