import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'ru-translator-chunks';
const STORE = 'chunks';
const DB_VERSION = 1;

/**
 * 4 MB. Small enough that a dropped connection loses at most a few seconds of
 * a slow transfer, large enough that the per-request overhead stays trivial
 * even across a hundred of them.
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

/** Only model downloads get this treatment; everything else uses plain fetch. */
const RESUMABLE_HOSTS = ['huggingface.co', 'cdn-lfs.huggingface.co', 'cdn-lfs-us-1.hf.co'];

let dbPromise: Promise<IDBPDatabase> | null = null;
function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'key' });
      },
    });
  }
  return dbPromise;
}

const originalFetch = globalThis.fetch.bind(globalThis);

function isResumableTarget(url: string, init?: RequestInit): boolean {
  try {
    if (init?.method && init.method.toUpperCase() !== 'GET') return false;
    // Never intercept our own ranged sub-requests.
    const headers = new Headers(init?.headers ?? {});
    if (headers.has('Range')) return false;
    const u = new URL(url, location.href);
    return RESUMABLE_HOSTS.includes(u.hostname) && u.pathname.includes('/resolve/');
  } catch {
    return false;
  }
}

async function probeTotalBytes(url: string, signal?: AbortSignal | null): Promise<number | null> {
  const res = await originalFetch(url, { headers: { Range: 'bytes=0-0' }, signal: signal ?? null });
  if (res.status !== 206) return null;
  const range = res.headers.get('content-range');
  const match = range?.match(/\/(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

async function readChunk(key: string): Promise<ArrayBuffer | null> {
  try {
    const rec = (await (await db()).get(STORE, key)) as { bytes: ArrayBuffer } | undefined;
    return rec?.bytes ?? null;
  } catch {
    return null;
  }
}

async function writeChunk(key: string, bytes: ArrayBuffer): Promise<void> {
  try {
    await (await db()).put(STORE, { key, bytes, at: Date.now() });
  } catch {
    // Out of quota, or private mode. The download still completes this session;
    // it just will not resume if it is interrupted.
  }
}

async function dropChunks(url: string, count: number): Promise<void> {
  try {
    const d = await db();
    const tx = d.transaction(STORE, 'readwrite');
    for (let i = 0; i < count; i++) tx.store.delete(`${url}#${i}`);
    await tx.done;
  } catch {
    /* best effort */
  }
}

/**
 * Fetch a large file in resumable 4 MB pieces.
 *
 * On a connection that drops repeatedly, a plain fetch of a 49 MB model can
 * never finish: every failure restarts from zero, so no progress is ever kept.
 * Pieces that have landed are stored in IndexedDB, so a retry picks up where
 * the last attempt stopped instead of starting again.
 *
 * The result is returned as a streaming Response, which means the caller's own
 * progress reporting keeps working unchanged — transformers.js reads the body
 * and counts bytes exactly as it would for a normal download.
 */
async function fetchResumable(url: string, init?: RequestInit): Promise<Response> {
  const signal = init?.signal ?? null;
  const total = await probeTotalBytes(url, signal);

  // No ranged support, or an unexpected response: behave exactly as before.
  if (total === null || total <= CHUNK_BYTES) {
    return originalFetch(url, init);
  }

  const chunkCount = Math.ceil(total / CHUNK_BYTES);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let i = 0; i < chunkCount; i++) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

          const key = `${url}#${i}`;
          let bytes = await readChunk(key);

          if (!bytes) {
            const start = i * CHUNK_BYTES;
            const end = Math.min(start + CHUNK_BYTES, total) - 1;
            const res = await originalFetch(url, {
              headers: { Range: `bytes=${start}-${end}` },
              signal,
            });
            if (!res.ok && res.status !== 206) {
              throw new Error(`Range request failed with ${res.status} for bytes ${start}-${end}`);
            }
            bytes = await res.arrayBuffer();
            await writeChunk(key, bytes);
          }

          controller.enqueue(new Uint8Array(bytes));
        }
        controller.close();
        // The whole file is now with the caller, which stores it in the model
        // cache. Keeping the pieces too would double the space for no benefit.
        void dropChunks(url, chunkCount);
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Length': String(total),
      'Content-Type': 'application/octet-stream',
    },
  });
}

let installed = false;

export function installResumableFetch() {
  if (installed) return;
  installed = true;

  const patched = globalThis.fetch;
  globalThis.fetch = function (this: unknown, input: any, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (typeof url === 'string' && isResumableTarget(url, init)) {
      // Fall back to the previous fetch on any problem — a resumable download
      // that misbehaves must never be worse than a plain one.
      return fetchResumable(url, init).catch(() => patched.call(this, input, init));
    }
    return patched.call(this, input, init);
  } as typeof fetch;
}

/** Bytes currently held as partial downloads. Shown in diagnostics. */
export async function partialBytes(): Promise<number> {
  try {
    const all = (await (await db()).getAll(STORE)) as { bytes: ArrayBuffer }[];
    return all.reduce((acc, r) => acc + (r.bytes?.byteLength ?? 0), 0);
  } catch {
    return 0;
  }
}

export async function clearPartials(): Promise<void> {
  try {
    await (await db()).clear(STORE);
  } catch {
    /* nothing to do */
  }
}
