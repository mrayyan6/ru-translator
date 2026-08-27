import type { NetworkProbeResult } from './types';

/**
 * An offline test that does not verify it is offline is worse than no test —
 * it is false confidence carried onto a plane. So before any result is stamped
 * PASS, we try to reach the network and require the attempt to FAIL.
 *
 * Two targets, chosen deliberately:
 *   - a bare IP, which succeeds even when DNS is down (proves the radio is off,
 *     not merely that name resolution broke)
 *   - a hostname, which additionally exercises DNS
 *
 * Both are zero-payload GETs. Nothing about the user, the audio, or the
 * conversation is sent. This probe exists only in the Phase 0 spike, and only
 * runs when the tester presses the button.
 */
/**
 * Both targets must send CORS headers.
 *
 * The page runs cross-origin isolated (COEP: require-corp), which blocks any
 * cross-origin response that does not opt in. A target without CORS therefore
 * fails identically whether the network is down or not — it reports "offline"
 * from a phone with full signal. An earlier probe used
 * `clients3.google.com/generate_204` and did exactly that.
 *
 * Both of these are Cloudflare endpoints that do send the headers, and the
 * second exercises DNS resolution as well as connectivity.
 */
const TARGETS = [
  { name: 'ip:1.1.1.1', url: 'https://1.1.1.1/cdn-cgi/trace' },
  {
    name: 'dns:cloudflare-dns.com',
    url: 'https://cloudflare-dns.com/dns-query?name=example.com&type=A',
  },
];

/**
 * Generous on purpose. At 4 seconds a genuinely slow-but-working connection
 * reported one target as unreachable, which is a false negative in the one
 * direction that matters — probes failing is how we conclude "offline".
 */
const TIMEOUT_MS = 8000;

async function probeOne(target: { name: string; url: string }) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(target.url, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
    return {
      target: target.name,
      reachable: res.status > 0,
      ms: Date.now() - started,
    };
  } catch (e: any) {
    return {
      target: target.name,
      reachable: false,
      ms: Date.now() - started,
      error: String(e?.message ?? e),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeNetwork(): Promise<NetworkProbeResult> {
  const attempts = await Promise.all(TARGETS.map(probeOne));
  const anyReachable = attempts.some((a) => a.reachable);
  const navigatorOnLine = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;

  /**
   * Failed probes alone are not proof of being offline, and getting this wrong
   * is asymmetric: a false "offline" silently promotes every INVALID result to
   * PASS, which is precisely the false confidence this whole check exists to
   * prevent. A blocked request, a firewall or a dead endpoint all look the same
   * from JavaScript.
   *
   * So we require corroboration. `navigator.onLine` is unreliable when it says
   * "online" but trustworthy when it says "offline" — airplane mode does set it
   * false. Probes failing while the browser still claims a connection is
   * therefore inconclusive, not offline.
   */
  const offline = !anyReachable && !navigatorOnLine;
  const inconclusive = !anyReachable && navigatorOnLine;

  return {
    offline,
    inconclusive,
    navigatorOnLine,
    checkedAt: new Date().toISOString(),
    attempts,
  };
}

/**
 * Counts outbound requests made by OUR JavaScript.
 *
 * How much this proves differs sharply between the two builds, and the earlier
 * plan overstated it for one of them:
 *
 *  - In the NATIVE app it proves very little. ML Kit, whisper.cpp and Google
 *    Play Services all call out from native code, below this layer, so a zero
 *    here is not evidence the app stayed offline.
 *
 *  - In the PWA it is far stronger. Everything runs in the JS sandbox, so with
 *    the counter installed before any other module, plus a service worker that
 *    serves only from cache, a zero really does mean nothing left the page.
 *    It is still not a substitute for the Airplane Mode test.
 */
let jsRequestCount = 0;
let probeDepth = 0;
let installed = false;

export function installJsNetworkCounter() {
  if (installed) return;
  installed = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    if (probeDepth === 0) jsRequestCount += 1;
    return originalFetch.apply(this, args);
  } as typeof fetch;
}

export function getJsRequestCount() {
  return jsRequestCount;
}

/** Wraps the deliberate probe so it doesn't inflate the counter it sits next to. */
export async function probeNetworkUncounted(): Promise<NetworkProbeResult> {
  probeDepth += 1;
  try {
    return await probeNetwork();
  } finally {
    probeDepth -= 1;
  }
}
