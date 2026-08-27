# Offline English ↔ Russian voice translator

One job: **speak English, hear Russian** and **speak Russian, hear English**, with the phone in
Airplane Mode.

Nothing has run on a real phone yet. Both spikes typecheck and build; that is all that is proven.

## Layout

```
core/     Platform-free TypeScript shared by both builds.
          Types, the travel-phrase corpus, the hallucination gate, the
          network probe, and the report generator. No React, no RN, no DOM.

web/      THE PRIMARY BUILD — a PWA. Free on iOS and Android, no store,
          no developer account. Vite + React + transformers.js.

spike/    The native React Native spike (Expo SDK 55), kept for the Android
          quality upgrade. Named `spike` because Windows holds a file lock on
          the folder; rename it to `native/` when convenient.
```

The three interfaces — `SpeechRecognizer`, `TranslationEngine`, `SpeechSynthesizer` — are the
seam. Each build supplies its own implementations; everything above them is shared.

## Why two builds

The family carries a mix of Android and iPhone.

- **PWA** reaches both, for free. It is the product.
- **Android APK**, sideloaded, is a free quality upgrade for the Android phones: native
  whisper.cpp is meaningfully faster and more accurate than WASM, and sideloading costs nothing
  — no Play Store, no fee.

Putting a *native* app on an iPhone is the only thing here that costs money ($99/yr Apple
Developer Program), and the PWA is precisely how we avoid it.

## Documents

| File | What it is |
| --- | --- |
| [PLAN.md](PLAN.md) | Original architecture and phase plan |
| [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md) | Critical review that reversed several of those decisions. **Where they disagree, the review wins.** |
| [web/README.md](web/README.md) | PWA: deployment, engines, discovered constraints |
| [spike/README.md](spike/README.md) | Native harness: prerequisites, test sequence |
| [spike/MODELS.md](spike/MODELS.md) | Getting Whisper model files onto a device |

## Current state

| | Status |
| --- | --- |
| PWA harness | Built. Typechecks, builds, service worker generated. **Not yet run on a phone.** |
| Native harness | Built. Typechecks, config plugins validate. **Not yet built or run** — needs the Android SDK. |
| Shared core | Types, corpus, hallucination gate, network probe, report generator |
| Model choices | Whisper base/small, OPUS-MT en↔ru, Web Speech / ML Kit / platform TTS |

## The next thing that has to happen

Deploy the PWA and run it on one real Android phone and one real iPhone. Everything after that
depends on numbers we do not have yet — particularly whether Russian speech recognition in
Safari is good enough to trust in a train station.

```powershell
cd web
npm run build
npx --yes wrangler pages deploy dist --project-name ru-translator
```

Then install to the home screen on both phones, download the models over Wi-Fi, enable Airplane
Mode, and run the sequence. The app produces the report; share it back.

## Non-negotiables

- No cloud inference. No audio or text leaves the device during use.
- No silent fallback to an online service, ever. A missing model says so.
- Airplane Mode is the acceptance gate. Nothing ships until a cold start in Airplane Mode
  completes the full pipeline in both directions.
