import { openDB, type IDBPDatabase } from 'idb';

/**
 * Mirrors transformers.js v4's `CacheInterface`. Declared here rather than
 * imported because the package does not re-export it from its entry point, and
 * reaching into `types/utils/cache.d.ts` would break on any internal reshuffle.
 */
interface CacheInterface {
  match(request: string): Promise<Response | undefined | string>;
  put(
    request: string,
    response: Response,
    progress_callback?: (data: { progress: number; loaded: number; total: number }) => void
  ): Promise<void>;
  delete?(request: string): Promise<boolean>;
}

const DB_NAME = 'ru-translator-models';
const STORE = 'files';
const DB_VERSION = 1;

interface StoredFile {
  url: string;
  bytes: ArrayBuffer;
  contentType: string;
  storedAt: number;
  size: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE, { keyPath: 'url' });
        }
      },
    });
  }
  return dbPromise;
}

/**
 * transformers.js v4's CacheInterface passes plain strings, not Request objects.
 * Normalising anyway costs nothing and keeps this usable if that ever changes.
 */
function keyOf(request: string | Request | URL): string {
  if (typeof request === 'string') return request;
  if (request instanceof URL) return request.href;
  return request.url;
}

/**
 * An IndexedDB-backed cache for transformers.js.
 *
 * This is not a micro-optimisation — it is the difference between the app
 * working on an iPhone and not. transformers.js caches model files through the
 * Cache API by default, and WebKit caps the Cache API at roughly 50 MB per
 * partition on mobile. A 200 MB Whisper model simply cannot be stored there.
 *
 * IndexedDB draws instead on the origin quota, which on iOS 17+ can reach 80%
 * of free disk. So models go here, and only the app shell uses the Cache API
 * (via the service worker).
 *
 * The shape — `match()` and `put()` — is what `env.customCache` expects.
 */
export const idbModelCache: CacheInterface = {
  async match(request: string): Promise<Response | undefined> {
    try {
      const record = (await (await db()).get(STORE, keyOf(request))) as StoredFile | undefined;
      if (!record) return undefined;
      return new Response(record.bytes, {
        status: 200,
        headers: { 'Content-Type': record.contentType || 'application/octet-stream' },
      });
    } catch {
      // A cache miss must never be fatal; the caller falls through to network,
      // and in offline mode that produces a clear error rather than a crash.
      return undefined;
    }
  },

  async put(request: string, response: Response): Promise<void> {
    try {
      const url = keyOf(request);
      const buf = await response.clone().arrayBuffer();
      const record: StoredFile = {
        url,
        bytes: buf,
        contentType: response.headers.get('Content-Type') ?? 'application/octet-stream',
        storedAt: Date.now(),
        size: buf.byteLength,
      };
      await (await db()).put(STORE, record);
    } catch (e) {
      // Most likely the origin quota is exhausted. Warn loudly rather than
      // failing the download: the model still works this session, it just
      // won't survive a restart, and the setup screen surfaces that.
      console.warn('[modelCache] could not store', keyOf(request), e);
      throw e;
    }
  },

  async delete(request: string): Promise<boolean> {
    try {
      await (await db()).delete(STORE, keyOf(request));
      return true;
    } catch {
      return false;
    }
  },
};

export interface CachedFileSummary {
  url: string;
  size: number;
  storedAt: number;
}

export async function listCachedFiles(): Promise<CachedFileSummary[]> {
  const all = (await (await db()).getAll(STORE)) as StoredFile[];
  return all
    .map(({ url, size, storedAt }) => ({ url, size, storedAt }))
    .sort((a, b) => b.size - a.size);
}

export async function cachedBytes(): Promise<number> {
  const files = await listCachedFiles();
  return files.reduce((acc, f) => acc + f.size, 0);
}

export async function clearModelCache(): Promise<void> {
  await (await db()).clear(STORE);
}

/**
 * Are all the files a model needs already stored?
 *
 * Deliberately a prefix match on the repo id rather than an exact manifest:
 * transformers.js decides which files it wants (which quantisation, whether it
 * needs a separate decoder) and we should not duplicate that logic here and
 * then drift from it.
 */
export async function hasCachedModel(repoId: string): Promise<boolean> {
  const files = await listCachedFiles();
  return files.some((f) => f.url.includes(repoId));
}
