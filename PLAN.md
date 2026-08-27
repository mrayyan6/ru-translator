# Offline EN ↔ RU Voice Translator — Architecture & Implementation Plan

Status: **Phase 0 spike built; app not started.** Last updated 2026-08-26.

> **Read `ARCHITECTURE-REVIEW.md` alongside this file.** It reverses two recommendations made
> below — the no-INTERNET "trip build" and the network-request counter as privacy evidence —
> and adds the hallucination defences this document under-weighted. Where the two disagree,
> the review wins.
>
> Also revised since: Expo SDK **55**, not 57 (newest ≠ safest for community native modules).

---

## 0. The one-line answer

React Native (Expo prebuild, New Architecture) → **whisper.cpp via `whisper.rn`** for STT →
**ML Kit on-device translation** (default) or **OPUS-MT INT8 ONNX** (open alternative) for MT →
**native TTS verified at runtime, with bundled Piper/VITS voices as the guarantee**.
Everything behind three swappable interfaces. Push-to-talk first. Airplane-mode test is the acceptance gate.

---

## 1. Framework decision

**Chosen: React Native, bare workflow via Expo prebuild + custom dev client, New Architecture ON, Expo SDK 57 / RN 0.86-ish (confirm exact versions at scaffold time).**

Not Expo Go — every ML library here is a native module.

### Why not Flutter

Flutter is a genuinely close second and I want to be honest about it: `sherpa-onnx` has **official** k2-fsa Flutter bindings, and `google_mlkit_translation` is a well-maintained Flutter package. Two of our three ML dependencies have *better* bindings on Flutter.

React Native wins on the other 70% of the app:

| Need | RN | Flutter |
|---|---|---|
| whisper.cpp binding maturity | `whisper.rn` — MIT, actively maintained by mybigday (same team as `llama.rn`), Core ML on iOS, Silero VAD built in, `RealtimeTranscriber`, Parakeet support | thinner, less battle-tested |
| sherpa-onnx binding | community only (`react-native-sherpa-onnx`, ~37★) | **official** |
| ML Kit translate | `fast-mlkit-translate-text` (thin, ~10 commits, iOS+Android+New Arch) | `google_mlkit_translation`, mature |
| Resumable downloads w/ progress | `expo-file-system` `createDownloadResumable` — best in class | manual |
| Writing our own native module | Expo Modules API: ~150 lines Kotlin + ~150 Swift, config plugin handles Gradle/Podfile | comparable |
| Permissions / device info / audio session | `expo-*` modules, excellent | good |

**Switch trigger:** if `whisper.rn` fails on either target device during Phase 0, re-evaluate Flutter + official sherpa-onnx bindings before writing app code. Phase 0 exists precisely to find this out cheaply.

---

## 2. Speech-to-text

**Chosen: `whisper.rn` (whisper.cpp), Whisper *small* multilingual, quantized.**

### The critical finding

**Whisper tiny and base are not good enough for Russian.** Multilingual tiny sits around 35–45% WER on Russian, base around 25–30%, small around 15–18%. Tiny/base are fine for English but will produce garbage Russian that then gets confidently mistranslated — the worst possible failure mode for a traveler.

So: **small is the floor for the Russian direction.** This drives pack size and latency more than any other decision.

### Model tiering

| Device class | Model | Size (approx) | Notes |
|---|---|---|---|
| Default (≥ 4 GB RAM) | `ggml-small` q5_0 | ~181 MB | both directions |
| iOS 15+ | + Core ML encoder `.mlmodelc` | +~150 MB | 2–3× faster encode; first load compiles (10–60 s) — needs a "Optimizing for your device…" screen |
| Low-end (< 4 GB RAM) | `ggml-base` q5_0 | ~57 MB | acceptable English, degraded Russian — warn the user explicitly |
| Benchmark candidate | Parakeet TDT 0.6B v3 | ~350–600 MB q | `whisper.rn` supports it; multilingual incl. Russian, transducer, much faster than Whisper. Evaluate in Phase 8 |

Quantization note: whisper.rn ships q4_0 / q4_k / q8_0 / f16. Avoid q5_1 (reported pathologically slow on some CPUs). Benchmark q5_0 vs q8_0 vs q4_k on the actual family devices.

**Rejected:** Vosk (weaker accuracy, poor iOS story), Moonshine / SenseVoice (no Russian), NLLB-scale ASR (too big), OS speech APIs (Android `SpeechRecognizer` / iOS `SFSpeechRecognizer` on-device) — both *may* work offline but neither can be **guaranteed**, and the spec forbids assuming.

License: Whisper models MIT (OpenAI), whisper.cpp MIT, whisper.rn MIT. Clean.

---

## 3. Translation — two engines, one interface

This is the highest-risk component, so it gets a primary and an alternative behind the same `TranslationEngine` interface.

### Engine A — ML Kit on-device translation (default, Phase 2)

- Runs **entirely locally**. It is *not* the Google Translate API — no request leaves the device at translate time.
- ~30 MB per language, downloaded once during setup. `isLanguageDownloaded()` is checkable.
- Works on **both** iOS and Android. Free. Quality on en↔ru is good for travel phrases.
- RN wrapper: `fast-mlkit-translate-text` (MIT, New Arch, iOS+Android). It's thin — if it breaks, wrapping the native SDK ourselves is ~300 lines total.

**Caveat you need to decide on:** ML Kit is closed-source Google, and its models download from Google's servers during setup. That's inside your stated "initial setup/model downloads" allowance, and runtime is 100% local — but if "no Google at all" is the actual requirement, say so and Engine B becomes the default.

### Engine B — OPUS-MT INT8 ONNX (open alternative, Phase 2b)

- `Helsinki-NLP/opus-mt-en-ru` + `opus-mt-ru-en`, exported to ONNX, INT8 quantized.
- ~80–110 MB per direction (~200 MB both). Runs on `onnxruntime-react-native` (Android + iOS).
- Fully open (models CC-BY 4.0, runtime MIT). Model files live in *our* pack — checksummable, verifiable, no third party.
- Work required: greedy decode loop + KV cache handling in TS/native, and a SentencePiece unigram tokenizer (either a ~250-line TS implementation or a small native module).

**Rejected:** NLLB-200-distilled-600M (~600 MB INT8, slow on phones — proven possible by RTranslator but Android-only and heavy); CTranslate2 (excellent runtime, but no mobile bindings and a painful iOS build); Bergamot/marian (tiny and fast, but mobile integration is entirely DIY); small LLMs via `llama.rn` (Gemma 3 1B etc. translate surprisingly well but are ~700 MB–1 GB, slow, and can hallucinate — unacceptable failure mode when someone is asking for a pharmacy).

### Engine C — Phrasebook (always available, Phase 2)

~300 pre-translated essential travel phrases bundled in the app binary, with audio pre-rendered or synthesized on demand. **This is not a nice-to-have — it is the floor of the product.** If every model fails, if the pack is deleted, if the phone is at 3% battery, the family can still ask where the toilet is. Cheap insurance.

**Plan:** ship A first to get a working prototype fast, add B in 2b, benchmark both in Phase 8 on real devices, and let the winner be the trip default. Settings screen exposes the choice.

---

## 4. Text-to-speech — verified, not assumed

**Two tiers. The spec is right to be suspicious here.**

### Tier 1 — native TTS (preferred: zero size, best quality)

Use `expo-speech` / `react-native-tts`, but **verify offline capability at runtime rather than assuming it**:

- **Android:** enumerate `Voice`s for `ru-RU`; reject any where `voice.isNetworkConnectionRequired() == true` or `voice.getFeatures()` contains `notInstalled`. If `isLanguageAvailable()` returns `LANG_MISSING_DATA`, fire `ACTION_INSTALL_TTS_DATA` and walk the user through installing Russian voice data during setup.
- **iOS:** enumerate `AVSpeechSynthesisVoice.speechVoices()` for `ru-RU`. Compact voices are on-device; enhanced/premium need download. There is no public "is offline" flag, so the only real proof is the airplane-mode test.

### Tier 2 — bundled Piper/VITS voices (the guarantee)

Via `react-native-sherpa-onnx` (MIT, TurboModule, Android API 24+ / iOS 13+, Expo config plugin):

- `ru_RU-irina-medium` ~63 MB, `en_US-amy-medium` or `en_US-lessac-medium` ~63 MB.
- Works regardless of what voices the phone has. Slower (Piper medium ≈ 0.2–0.5× RTF on phone CPU) but bulletproof.

**Licensing flag:** the `rhasspy/piper-voices` repo is MIT, but the `irina` model card lists its underlying *dataset* license as "Unknown." Fine for a private family build; **verify before any public App Store / Play distribution.** Alternative Russian voices (`dmitri`, `denis`, `ruslan`) need the same check.

Setup flow: run a real synthesis test on both languages during pack install. If native passes → use native, skip the 130 MB download. If it fails → download Piper voices and say so plainly.

---

## 5. Guaranteeing offline — beyond "trust us"

The spec's strongest requirement deserves a stronger answer than an interface abstraction.

1. **Android: a `trip` product flavor with `android.permission.INTERNET` removed from the manifest.** The OS then makes network access *impossible*, not merely unused. This is a hard, auditable guarantee. Install the normal build, download the pack, then side-load the trip build (models persist in shared app storage — or re-download once). Worth the small hassle for total certainty.
2. **iOS:** no equivalent entitlement. Guarantee comes from (a) airplane-mode acceptance test, (b) code audit showing no network call paths in the inference libraries, (c) the runtime guard below.
3. **Runtime network guard (both platforms):** monkey-patch `fetch` / `XMLHttpRequest` at app boot. Once "offline mode" is armed (post-setup), any outbound call **throws and is logged**. The main screen shows a live counter: `Network requests since launch: 0`. That directly answers "never make the user wonder."
4. **Never silently degrade.** Missing pack → `"Russian offline language pack is not installed."` and a button to install it. No fallback, no retry-online, ever.

---

## 6. Model pack system

Single pack, `ru-en-v1`, described by a signed-ish manifest:

```
{ id, version, files: [{ url, sha256, bytes, dest, required }], totalBytes, minRam, minStorage }
```

- Downloads from Hugging Face CDN via `expo-file-system` `createDownloadResumable` — resumable, backgroundable, progress-reporting.
- **Atomic install:** download to `.tmp` → verify SHA-256 → rename into place. A half-downloaded file must never be loadable.
- Pre-flight: free storage check with 20% headroom, RAM check, OS version check.
- Verify / repair / delete / re-download, all user-accessible.
- Show: per-file progress, total size, free space, installed version, and a per-capability checklist.

**Expected pack size**

| Component | Android | iOS |
|---|---|---|
| Whisper small q5_0 | 181 MB | 181 MB |
| Core ML encoder | — | ~150 MB |
| Silero VAD | 2 MB | 2 MB |
| Translation (ML Kit en+ru) | ~60 MB | ~60 MB |
| Translation (OPUS-MT ONNX, if Engine B) | ~200 MB | ~200 MB |
| Piper voices (only if native TTS fails) | ~130 MB | ~130 MB |
| **Typical total** | **~250–450 MB** | **~400–600 MB** |

---

## 7. Expected performance (estimates — replace with real numbers in Phase 8)

Mid-range device (Pixel 7a / iPhone 12 class), 4-second utterance:

| Stage | Android | iOS (Core ML) |
|---|---|---|
| STT — Whisper small | 1.5–3.5 s | 0.8–1.5 s |
| STT — Whisper base | 0.6–1.2 s | 0.4–0.8 s |
| MT — ML Kit | 50–200 ms | 50–200 ms |
| MT — OPUS-MT INT8 | 300–900 ms | 300–900 ms |
| TTS — native | 100–300 ms to first audio | 100–300 ms |
| TTS — Piper medium | 1–2 s | 1–2 s |
| **End-to-end target** | **≤ 4.5 s** | **≤ 3 s** |

Model stays loaded in memory between utterances (load once, reuse). Peak RAM with Whisper small ≈ 400–700 MB — check headroom on low-RAM devices and drop to base rather than OOM-crashing.

---

## 8. Project structure

```
/app                    expo-router screens (translate, conversation, setup, offline-test, settings)
/src
  /ui                   components, theme, large-text views, "show this to them" fullscreen mode
  /audio                recorder (16 kHz mono PCM), audio session, interruptions, focus, VAD
  /stt                  SpeechRecognizer.ts (interface) + WhisperRnRecognizer, MockRecognizer
  /translation          TranslationEngine.ts + MlKitEngine, OpusMtOnnxEngine, PhrasebookEngine
  /tts                  SpeechSynthesizer.ts + NativeTtsSynthesizer, PiperSynthesizer
  /models               manifest, pack definitions, checksums, device→model tiering
  /offline              OfflineModelManager, downloader, verifier, networkGuard, selfTest
  /storage              conversation store (in-memory by default), settings, saved phrases
  /platform             device capabilities (RAM, arch, OS, storage), permissions
  /core                 errors, result types, local-only logger (no telemetry)
/assets/phrasebook      ~300 bundled travel phrases
/e2e                    Maestro flows
/__tests__
```

### Interfaces

```ts
interface SpeechRecognizer {
  initialize(cfg: ModelRef): Promise<void>
  isReady(): boolean
  startRecording(opts: { maxDurationMs: number; lang: Lang }): Promise<void>
  stopRecording(): Promise<Float32Array>      // 16 kHz mono
  cancel(): void
  transcribe(audio: Float32Array, lang: Lang): Promise<Transcript>
  release(): Promise<void>
}

interface TranslationEngine {
  id: 'mlkit' | 'opusmt' | 'phrasebook'
  initialize(): Promise<void>
  isPairAvailable(from: Lang, to: Lang): Promise<boolean>
  translate(text: string, from: Lang, to: Lang): Promise<string>
  release(): Promise<void>
}

interface SpeechSynthesizer {
  initialize(): Promise<void>
  isLanguageOfflineCapable(lang: Lang): Promise<boolean>   // must actually verify
  speak(text: string, lang: Lang): Promise<void>
  stop(): void
}

interface OfflineModelManager {
  getStatus(): Promise<PackStatus>
  downloadPack(onProgress: (p: Progress) => void): Promise<void>
  verifyPack(): Promise<VerifyReport>
  deletePack(): Promise<void>
}
```

---

## 9. Implementation phases

### Phase 0 — De-risk spike (do this first, throw the code away) ⚠️
Not in the original spec, and the most valuable change to it. Before any app architecture, prove on **one real Android phone and one real iPhone**:
- `whisper.rn` loads Whisper small q5_0 and transcribes Russian and English acceptably
- `fast-mlkit-translate-text` (or a hand-rolled native module) translates en↔ru on both platforms
- native TTS speaks Russian **in airplane mode**; if not, `react-native-sherpa-onnx` + Piper does

If any leg fails, the architecture changes — better to know in 2 days than 2 weeks.

### Phase 1 — Skeleton, mic, STT
Expo prebuild scaffold, New Arch, dev client on both devices. Permissions, audio session, push-to-talk with max duration and cancel. `SpeechRecognizer` + whisper.rn impl + mock impl. Raw transcript on screen.

### Phase 2 — Translation
`TranslationEngine` + ML Kit impl + phrasebook impl. Direction switching. English↔Russian both ways.

### Phase 2b — Open translation engine *(conditional)*
OPUS-MT ONNX impl + SentencePiece. Only if ML Kit disappoints or "no Google" is a hard requirement.

### Phase 3 — TTS
`SpeechSynthesizer` + native impl with real offline verification. Piper fallback wired in.

### Phase 4 — Full push-to-talk pipeline
Hold → record → VAD trim → STT → MT → display → auto-speak. Full error taxonomy, cancellation at every stage, model kept warm.

### Phase 5 — Model pack system
Manifest, resumable download, checksums, atomic install, storage/RAM pre-flight, verify/delete/re-download UI.

### Phase 6 — Offline verification
`TEST OFFLINE MODE` screen running the six checks end-to-end with real inference (not just file-existence). Network guard + request counter. Then: *"Turn on Airplane Mode and test again."*

### Phase 7 — Conversation mode
Alternating turns, large text, in-memory history, clear button, no audio persisted unless explicitly enabled. Plus: **"show this to them"** fullscreen Cyrillic display, and Latin transliteration of Russian output so an English speaker can attempt it aloud.

### Phase 8 — Performance & device tiering
Benchmark harness: quantization variants, Whisper small vs base vs Parakeet, ML Kit vs OPUS-MT, thread counts. Auto-select model from measured results, not hardcoded rules. Measure startup, load, per-stage latency, RAM, battery.

### Phase 9 — Android testing + `trip` no-INTERNET flavor
### Phase 10 — iOS testing (device provisioning, background download, Core ML first-load UX)
### Phase 11 — PWA investigation *(likely: don't)* — see §11

---

## 10. Testing

**Automated (Jest + mocked engines):** direction switching, pack-missing state, pack-corrupt state, permission-denied, storage-full, inference failure, conversation store, network guard throws when armed, TTS-unavailable fallback.

**Golden set:** ~60 travel sentences per direction. Freeze the current output as reference and assert on it — this is a **regression** test, not a quality test. Be honest about that distinction.

**E2E (Maestro):** full push-to-talk flow with a mock recognizer feeding pre-recorded audio.

**Manual device checklist:**
1. Wi-Fi ON — everything works
2. Wi-Fi OFF, data ON
3. Both OFF
4. **Airplane Mode ON — the acceptance gate. Nothing ships until this passes on both phones.**
5. Airplane mode + cold app start (proves nothing was cached from a live session)
6. Noisy environment (station concourse recording played back)
7. Bluetooth headset, wired headset, speaker
8. Incoming call mid-recording
9. Low battery / low storage
10. Pack deleted → correct message, no crash, phrasebook still works

---

## 11. PWA verdict — no

Android Chrome could plausibly run whisper.cpp WASM + transformers.js OPUS-MT with WebGPU. **iOS Safari cannot be relied on:** memory ceilings that kill tabs holding a 200 MB model, patchy WebGPU, no guaranteed persistence for large IndexedDB blobs (7-day eviction for non-installed sites), and no offline TTS story since Web Speech API voices are frequently server-backed.

**Do not depend on a PWA for this trip.** Revisit only after the native app ships, and only as a laptop-side convenience.

---

## 12. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Whisper small too slow / too big on the family's actual phones | **High** | Phase 0 benchmark; base fallback with an explicit accuracy warning; evaluate Parakeet |
| 2 | Russian STT degrades badly in station/street noise | **High** | Push-to-talk close-mic, VAD, editable transcript before translating, phrasebook fallback |
| 3 | `fast-mlkit-translate-text` is a thin wrapper that may break | Medium | Fallback is ~300 lines of our own Kotlin/Swift; Engine B exists |
| 4 | `react-native-sherpa-onnx` is community-maintained (~37★) | Medium | Only needed if native TTS fails; pin the version, vendor if necessary |
| 5 | Piper Russian voice dataset licensing unclear | Medium | Fine for private build; resolve before public distribution |
| 6 | ML Kit is closed-source Google | Medium | Engine B is the escape hatch — decide early |
| 7 | Core ML first-load compile stalls iOS for up to 60 s | Low | Do it during pack install with a progress screen, never on first translate |
| 8 | 400–600 MB pack on a full phone | Low | Pre-flight storage check with headroom; base-model slim pack option |
| 9 | Download interrupted / app killed mid-install | Low | Resumable download + atomic rename + verify |

---

## 13. Open decisions for you

1. **ML Kit acceptable?** It's fully local at runtime but closed-source Google, models fetched from Google servers at setup. Yes → fastest path to a working prototype. No → Engine B becomes default and Phase 2 costs about a week more.
2. **Which phones?** Exact models for the family determine model tiering, and I'd like to benchmark against the real hardware in Phase 0.
3. **Distribution:** side-loaded / TestFlight family build, or actual store release? Store release makes the Piper licensing question real and adds review time.
4. **Trip date?** Drives how much of Phases 7–8 is worth doing.
