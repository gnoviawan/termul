export async function isPermissionGranted(): Promise<boolean> {
  return false
}

export async function requestPermission(): Promise<'granted' | 'denied' | 'default'> {
  return 'denied'
}

export function sendNotification(_options: unknown): void {
  // no-op in web build
}
