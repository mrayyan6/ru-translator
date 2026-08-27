import { idbModelCache } from './modelCache';

type TransformersModule = typeof import('@huggingface/transformers');

let modulePromise: Promise<TransformersModule> | null = null;
let loadedEnv: TransformersModule['env'] | null = null;
let allowRemote = true;

/**
 * transformers.js is loaded through a dynamic import, deliberately.
 *
 * Loading it statically put it in the same chunk as the app, and the bundler's
 * hoisting of the library's own circular internals produced a temporal-dead-zone
 * crash at runtime ("cannot access 'r' before initialization") the moment a
 * pipeline was constructed. A dynamic import gives the library its own chunk
 * with its own initialisation order, which is both the documented pattern and
 * the robust one.
 *
 * It also means the 750 kB library is not in the critical path: the UI paints
 * before any of it is fetched.
 */
export async function getTransformers(): Promise<TransformersModule> {
  if (!modulePromise) {
    modulePromise = import('@huggingface/transformers').then((mod) => {
      configureEnv(mod.env);
      loadedEnv = mod.env;
      return mod;
    });
  }
  return modulePromise;
}

/**
 * Two settings carry the whole offline story:
 *
 *  - `useCustomCache` routes model files into IndexedDB instead of the Cache
 *    API, because WebKit caps the Cache API near 50 MB on mobile and a Whisper
 *    model does not fit.
 *
 *  - `allowRemoteModels` is the offline switch. Once setup is done we set it to
 *    false, so a missing file surfaces as a clear error instead of a silent
 *    attempt to reach huggingface.co.
 */
function configureEnv(env: TransformersModule['env']) {
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = idbModelCache;

  env.allowLocalModels = false;
  env.allowRemoteModels = allowRemote;

  const wasm = env.backends?.onnx?.wasm;
  if (wasm) {
    // Multi-threading only works in a cross-origin isolated context. Asking for
    // threads without it makes onnxruntime-web throw rather than fall back, so
    // gate on the flag the browser actually reports.
    const isolated = Boolean((globalThis as any).crossOriginIsolated);
    const cores = navigator.hardwareConcurrency ?? 4;
    wasm.numThreads = isolated ? Math.max(1, Math.min(4, cores - 1)) : 1;
    wasm.proxy = false;
  }
}

/** Safe to call before the library has loaded; the value is applied on load. */
export function setOfflineMode(offline: boolean) {
  allowRemote = !offline;
  if (loadedEnv) loadedEnv.allowRemoteModels = allowRemote;
}

export function isOfflineModeArmed() {
  return !allowRemote;
}

/**
 * Run an explicitly user-initiated download with remote access enabled, then
 * restore whatever the previous state was.
 *
 * Offline mode used to be armed once and left on, which meant any later model
 * load — pressing "Load Whisper" in diagnostics, switching direction, adding a
 * second language — died with "both local and remote models are disabled".
 * `allowLocalModels` is false in a browser by definition, so arming offline
 * mode globally disables *all* loading, not just network loading.
 *
 * Downloading is a setup activity and is always something the user asked for.
 * What must never happen is a silent fetch during use, and that is preserved:
 * outside this wrapper remote loading stays off, so a missing model still
 * fails loudly instead of quietly reaching for the network.
 */
export async function withDownloadsAllowed<T>(work: () => Promise<T>): Promise<T> {
  const wasArmed = !allowRemote;
  setOfflineMode(false);
  try {
    return await work();
  } finally {
    setOfflineMode(wasArmed);
  }
}

export function transformersDiagnostics() {
  return {
    libraryLoaded: loadedEnv !== null,
    wasmThreads: loadedEnv?.backends?.onnx?.wasm?.numThreads ?? null,
    crossOriginIsolated: Boolean((globalThis as any).crossOriginIsolated),
    allowRemoteModels: loadedEnv ? loadedEnv.allowRemoteModels : allowRemote,
    customCache: loadedEnv ? loadedEnv.useCustomCache : null,
  };
}

/** WebGPU is a large speedup where present, but is still flagged off in Safari. */
export async function detectWebGpu(): Promise<{ available: boolean; reason: string }> {
  const gpu = (navigator as any).gpu;
  if (!gpu) {
    return {
      available: false,
      reason: 'navigator.gpu missing — on iOS this usually means the Safari WebGPU flag is off',
    };
  }
  try {
    const adapter = await gpu.requestAdapter();
    return adapter
      ? { available: true, reason: 'adapter acquired' }
      : { available: false, reason: 'no WebGPU adapter available' };
  } catch (e: any) {
    return { available: false, reason: `requestAdapter failed: ${e?.message ?? e}` };
  }
}
