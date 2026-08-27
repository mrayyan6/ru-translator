/**
 * The escape hatch for a stuck service worker.
 *
 * Unregisters every service worker and deletes every Cache Storage entry, then
 * reloads. The next load fetches a completely fresh shell.
 *
 * Downloaded models are NOT touched: they live in IndexedDB, and `caches`
 * covers only the Cache API. Clearing the shell costs a few megabytes to
 * re-fetch; clearing the models would cost 300 MB and a lot of goodwill.
 */
export async function forceUpdate(): Promise<void> {
  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
    }
  } catch {
    /* keep going — clearing caches alone is usually enough */
  }

  try {
    if ('caches' in globalThis) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* keep going — the reload below may still pick up a new shell */
  }

  location.reload();
}
