import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { installJsNetworkCounter } from '@core/netprobe';
import { installResumableFetch } from './resumableFetch';
import Shell from './Shell';
import './index.css';

/**
 * The network counter patches `fetch`, so it must be installed before any other
 * module captures a reference to the original — which is why this is the first
 * statement in the entry point.
 *
 * In a PWA this counter is worth considerably more than it was in the native
 * app: everything runs inside the JS sandbox, so a zero really does mean
 * nothing left the page.
 *
 * transformers.js is deliberately NOT touched here. It is dynamic-imported on
 * first use (see transformersEnv.ts) so that it gets its own chunk — importing
 * it eagerly is what caused an earlier initialisation crash.
 */
installJsNetworkCounter();

/**
 * Then make model downloads resumable. Order matters: the counter wraps the
 * real fetch, and this wraps the counter, so counted requests stay counted.
 *
 * On a slow or flaky connection a plain fetch of a 49 MB model never finishes —
 * every drop restarts from zero and nothing is kept. This stores 4 MB pieces as
 * they land so a retry continues instead of starting over.
 */
installResumableFetch();

/**
 * Service worker registration, done by hand rather than by the plugin's
 * generated snippet.
 *
 * An installed PWA serves its shell from precache, so a new deploy is only
 * picked up when the browser re-fetches sw.js and sees it change. Left to
 * itself that check is unreliable enough that the app can stay frozen on an
 * old build through repeated force-closes — which is what happened.
 *
 * Two things fix it: `_headers` makes sw.js uncacheable, and this asks the
 * registration to check for a new version on an interval and whenever the app
 * comes back to the foreground.
 */
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;

    const check = () => registration.update().catch(() => undefined);
    setInterval(check, 60_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell />
  </StrictMode>
);
