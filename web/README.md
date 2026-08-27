# Web spike — the PWA

The primary build. Free on both platforms, no store, no developer account, no fee.

`tsc --noEmit` passes and `npm run build` produces a working service worker. Nothing here has
run on a real phone yet — that is what the spike is for.

## Why Cloudflare Pages and not GitHub Pages

Because of two headers.

`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` put
the page in a cross-origin isolated context, which is the precondition for `SharedArrayBuffer`
and therefore for **multi-threaded WASM**. Without them, onnxruntime-web runs on a single
thread and speech recognition gets several times slower — the difference between usable and
unusable on an iPhone, where WebGPU is still behind a Safari flag and WASM is all we have.

**GitHub Pages cannot set response headers at all.** Cloudflare Pages and Netlify read the
`public/_headers` file in this project. That single limitation is the whole reason for the
choice.

The app tells you which way it went: the Environment panel shows `cross-origin isolated: yes/no`
and the report records it, so a bad deploy shows up as a number rather than a mystery.

## Deploying

```powershell
cd "d:\Russia Language\web"
npm run deploy
```

**Always use `npm run deploy`, never a bare `wrangler pages deploy`.**

The script passes `--branch production`, and that flag is load-bearing. This
project's production branch is named `production`, but once the folder became a
git repository wrangler started inferring the branch from git — `main` — and
Cloudflare treats any branch that is not the production branch as a *preview*.
The result is a deploy that reports success, returns a working URL, and leaves
`ru-translator.pages.dev` frozen on an older build. It cost a full debugging
round to find, because every symptom pointed at browser caching instead.

To check what production is actually serving:

```powershell
(Invoke-WebRequest https://ru-translator.pages.dev/ -UseBasicParsing).Content `
  -match 'assets/index-[A-Za-z0-9\-]+\.js'; $Matches[0]
```

Compare that against the filename in `dist/index.html`. If they differ, the
deploy did not land on production.

The first run opens a browser to create a free Cloudflare account. After that it prints an
HTTPS URL. Alternatively, drag the `dist` folder onto the Cloudflare Pages dashboard.

**HTTPS is not optional** — browsers refuse `getUserMedia` on plain HTTP from anything but
localhost, so the microphone simply will not work over a LAN address.

### Faster iteration while developing

```powershell
npm run dev                                      # localhost only: mic works here
npx --yes cloudflared tunnel --url http://localhost:5173   # HTTPS URL for phone testing
```

The quick tunnel needs no account. Note that it does **not** apply `_headers`, so
cross-origin isolation will read `no` and things will be slower — fine for checking
functionality, not for taking timings.

## Installing on a phone

Storage behaviour differs sharply between a browser tab and an installed app, so install first,
then download models.

- **iOS:** Safari → Share → *Add to Home Screen*. Must be Safari; Chrome on iOS cannot install.
- **Android:** Chrome → menu → *Install app* / *Add to Home Screen*.

Then open from the home-screen icon and press **Request persistent storage**. Without it,
WebKit deletes script-created storage after seven days without interaction — which is precisely
the shape of "download the pack, don't open it for two weeks, land in Moscow."

## What the spike measures

Same discipline as the native harness: it probes the network first and stamps any offline claim
`INVALID` if the network was actually reachable, because an offline test that doesn't verify
it's offline is false confidence carried onto a plane.

It records browser, platform, OS, cores, `deviceMemory`, whether it is installed, whether it is
cross-origin isolated, whether WebGPU is available, whether persistent storage was granted,
cache size against origin quota, and per-stage latency for every run.

## Engines

| Stage | Engine | Notes |
| --- | --- | --- |
| STT (Android) | Chrome on-device Web Speech API | Platform recogniser. Fast, good Russian, nothing to ship. Gated on `available({processLocally: true})` — if the browser can't confirm local processing we refuse to use it, because plain `webkitSpeechRecognition` streams audio to a server. |
| STT (iOS) | Whisper via transformers.js | `onnx-community/whisper-base` or `-small`, q8 on WASM / q4 on WebGPU. The slow leg. |
| Translation | OPUS-MT ONNX via transformers.js | `Xenova/opus-mt-en-ru` and `-ru-en`. Both stay loaded, so direction switching and round-trip back-translation are free — unlike the native ML Kit wrapper, which holds one pair at a time. |
| TTS | Web Speech API | Filtered on `SpeechSynthesisVoice.localService`, the browser's own "is this voice local" flag. Remote voices are rejected before we ever speak. |

## Constraints discovered while building this

- **The onnxruntime WASM binary is 23.6 MB** and must be precached — without it there is no
  inference offline regardless of how many models are stored. The app shell is therefore ~25 MB
  against WebKit's ~50 MB Cache API budget on mobile. It fits; the headroom is thin.
- **Models cannot live in the Cache API** for the same reason, so they go in IndexedDB, which
  draws on the origin quota (up to 80% of free disk on iOS 17+) instead.
- **transformers.js defaults to the Cache API**, so `env.useCustomCache` is redirected to an
  IndexedDB implementation in `src/modelCache.ts`. Without that change the app would fail on
  iOS the moment a model exceeded 50 MB.
- **Peak memory is unmeasurable from a browser.** If the tab exceeds its limit it simply
  reloads. That is a worse failure than the native app's, and there is no instrumentation for it.

## Known gaps

- Placeholder icons — `public/icon-192.png` and `icon-512.png` are copies of the native app
  icon at nominal sizes. Replace before real use or installation prompts may misbehave.
- No Piper WASM TTS fallback yet. If `localService` voices turn out to be missing for Russian
  on a target device, that is the next thing to add.
- No VAD. The native spike gates on Silero; here the only guard against a dead microphone is a
  peak-amplitude check, plus the shared blocklist and repetition detection.
