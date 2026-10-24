import { APP_VERSION } from './updates-section'

/**
 * The termul-server version the Logs section names. The browser client is
 * served by its termul-server, so its own build version is the server's.
 * The GPUIX client is a separate build and asks the server instead
 * (`apps/gpuix/src/overrides/pages/app-preferences/use-server-version.ts`).
 */
export function useServerVersion(): string {
  return APP_VERSION
}
