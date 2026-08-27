/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Build time as epoch milliseconds, injected by vite.config.ts.
 * Format it with `buildLabel()` so it renders in the device's own timezone.
 */
declare const __BUILD_TIME__: number;
