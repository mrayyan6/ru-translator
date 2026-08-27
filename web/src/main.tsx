import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installJsNetworkCounter } from '@core/netprobe';
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
 * it eagerly is what caused the initialisation crash.
 */
installJsNetworkCounter();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell />
  </StrictMode>
);
