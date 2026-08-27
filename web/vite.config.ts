import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';

/**
 * Cross-origin isolation (COOP + COEP) is what unlocks SharedArrayBuffer, and
 * therefore multi-threaded WASM. Without it onnxruntime-web falls back to a
 * single thread and speech recognition gets several times slower — which is the
 * difference between usable and not on an iPhone.
 *
 * These headers cover `vite dev` and `vite preview`. In production they must
 * come from the host, which is why this targets Cloudflare Pages (a `_headers`
 * file, see public/_headers) rather than GitHub Pages, which cannot set them.
 */
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: any) {
    server.middlewares.use((_req: any, res: any, next: any) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
  configurePreviewServer(server: any) {
    server.middlewares.use((_req: any, res: any, next: any) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
};

/**
 * Stamped into the bundle so the running build is identifiable at a glance.
 * Without it there is no way to tell a stale service worker from a real bug,
 * and we spent a round trip finding that out.
 */
const BUILD_ID = new Date()
  .toISOString()
  .replace('T', ' ')
  .replace(/\..+$/, '')
  .slice(5); // MM-DD HH:MM:SS

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [
    react(),
    crossOriginIsolation,
    VitePWA({
      registerType: 'autoUpdate',
      // Registered by hand in main.tsx so we can poll for updates rather than
      // relying on the browser noticing one on its own.
      injectRegister: false,
      manifest: {
        name: 'Offline RU Translator',
        short_name: 'RU Translator',
        description: 'English ↔ Russian voice translation that works in Airplane Mode.',
        start_url: '.',
        display: 'standalone',
        background_color: '#10161a',
        theme_color: '#10161a',
        orientation: 'portrait',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app shell is precached so a cold start in Airplane Mode works.
        // Models are NOT handled here — they live in IndexedDB, because WebKit
        // caps the Cache API at roughly 50 MB on mobile and a 200 MB model
        // would simply fail to store.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
        // The onnxruntime-web WASM binary is ~24 MB on its own and MUST be
        // precached — without it there is no inference offline, no matter how
        // many models are stored. That puts the app shell around 25 MB against
        // WebKit's ~50 MB Cache API budget on mobile: it fits, but the headroom
        // is thin, and it is a second reason models live in IndexedDB instead.
        maximumFileSizeToCacheInBytes: 32 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('../core', import.meta.url)),
    },
  },
  optimizeDeps: {
    // transformers.js ships its own WASM/worker assets; letting Vite prebundle
    // it rewrites those paths and breaks resolution at runtime.
    exclude: ['@huggingface/transformers'],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Keep transformers.js and onnxruntime in their own chunks. Bundled
          // together with the app they were hoisted into a single scope, and
          // the library's internal circular references then blew up as a
          // temporal-dead-zone error at pipeline construction time.
          if (id.includes('onnxruntime')) return 'onnxruntime';
          if (id.includes('@huggingface/transformers')) return 'transformers';
          return undefined;
        },
      },
    },
  },
  server: {
    host: true, // needed to open the dev server from a phone on the same network
  },
});
