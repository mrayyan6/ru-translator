export interface StorageStatus {
  /** Bytes the browser says this origin is currently using. */
  usageBytes: number | null;
  /** Bytes the browser is willing to give this origin. */
  quotaBytes: number | null;
  /**
   * True when the origin is in persistent mode. Persistent origins are skipped
   * during automatic eviction, which is what stops iOS deleting a 200 MB model
   * after a week of not using the app.
   */
  persisted: boolean;
  /** True when the page is cross-origin isolated, so multi-threaded WASM works. */
  crossOriginIsolated: boolean;
  /** True when running as an installed home-screen app rather than a browser tab. */
  standalone: boolean;
}

export async function getStorageStatus(): Promise<StorageStatus> {
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  let persisted = false;

  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      usageBytes = est.usage ?? null;
      quotaBytes = est.quota ?? null;
    }
  } catch {
    /* Safari can refuse; unknown beats wrong. */
  }

  try {
    persisted = (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    persisted = false;
  }

  return {
    usageBytes,
    quotaBytes,
    persisted,
    crossOriginIsolated: Boolean((globalThis as any).crossOriginIsolated),
    standalone: isStandalone(),
  };
}

export function isStandalone(): boolean {
  const iosStandalone = (navigator as any).standalone === true;
  const displayMode =
    typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
  return Boolean(iosStandalone || displayMode);
}

/**
 * Ask the browser to keep this origin's data.
 *
 * Without it, WebKit deletes script-created storage after seven days without
 * user interaction — which is exactly the shape of "download the pack, don't
 * open the app for two weeks, then land in Moscow". Safari is more willing to
 * grant this to an installed home-screen app, which is why the setup flow
 * pushes for installation before download.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export function formatBytes(b: number | null | undefined): string {
  if (b === null || b === undefined) return 'unknown';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}
