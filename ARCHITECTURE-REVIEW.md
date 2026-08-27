# Critical review of my own architecture

Written 2026-08-26, before any code. Ranked by *probability × damage in the field*, not by how interesting the problem is.

The question I'm answering: **what actually stops this working in Airplane Mode in a Russian train station?**

---

## R1 — Whisper hallucinates. I under-weighted this badly. `CHANGES ARCHITECTURE`

Whisper is autoregressive. On silence, breath, or background noise it does not return empty — it **invents fluent text**. The known attractors are notorious: `"Thank you."`, `"Продолжение следует..."`, `"Субтитры сделал DimaTorzok"`, `"Редактор субтитров А.Синецкая"`.

This is the **single most dangerous failure mode in the whole system**, because it is silent, confident, and indistinguishable from a correct result. A traveler presses the mic in a noisy concourse, releases, and the app confidently speaks a fluent Russian sentence that has nothing to do with what was said. Worse than an error. Worse than a crash.

My original plan treated this as a tuning detail. It is not — it is architectural.

**Changes:**

1. **VAD gate before transcription.** Silero VAD runs first; if no speech segment is found, the pipeline stops with *"Didn't catch that"* and never reaches Whisper.
2. **Minimum audio duration** (~400 ms of detected speech) or reject.
3. **`temperature = 0`, no temperature fallback.** Temperature fallback is a hallucination amplifier.
4. **Confidence gate.** Reject on `no_speech_prob` above threshold or `avg_logprob` below threshold. Both are exposed per-segment by whisper.cpp.
5. **Hallucination blocklist**, per language, checked after decode.
6. **Never auto-speak an unconfirmed low-confidence transcript.** The transcript is always displayed. High confidence → auto-speak. Low confidence → show *"Didn't catch that — try again"* and speak nothing.
7. **Contingency with a defined trigger:** if Phase 0 noise testing shows hallucination surviving all of the above, switch STT to a transducer/CTC model via sherpa-onnx (GigaAM-v2 for Russian, Zipformer for English). CTC and transducer models **cannot hallucinate this way** — no autoregressive text decoder. They may score slightly worse on clean speech and would be more reliable in the field. That trade is worth taking if the trigger fires.

---

## R2 — My JS network guard was theatre. `CORRECTS A CLAIM I MADE`

I proposed patching `fetch`/`XMLHttpRequest` and showing "Network requests since launch: 0".

**That guard cannot observe native traffic.** ML Kit, whisper.cpp and Google Play Services all make their calls from native code, entirely below the JS layer. My counter would happily display `0` while a native library talked to a server. As evidence of the offline guarantee, it was worth close to nothing, and displaying it as proof would have been actively misleading.

**Changes:**

1. Keep the JS guard, but **label it honestly**: it covers *our* code only. It is a development assertion, not a privacy proof.
2. **The Android build with `android.permission.INTERNET` removed becomes the primary evidence artifact.** It is OS-enforced and therefore *does* cover native code. If the full pipeline runs in that build, no native library needed the network. That is real proof.
3. But **it is not the trip build** — see R3.
4. Airplane Mode remains the definitive test for the actual usage scenario, on both platforms.

---

## R3 — The no-INTERNET "trip build" was a bad idea. `REVERSES MY RECOMMENDATION`

I recommended shipping the family a build with `INTERNET` stripped. Reliability-first, that is wrong:

- ML Kit may need Play Services module installation at first use. Stripping `INTERNET` risks breaking **translator initialization**, not merely downloads.
- It removes the recovery path. If a model is corrupted in Russia and there is hotel Wi-Fi, the no-INTERNET build cannot re-download. That is a worse outcome than the guarantee is worth.
- It doubles the tested surface. **An under-tested second build is a bigger reliability risk than the risk it mitigates.**

**Change:** one build ships. The no-INTERNET variant is built **once, in Phase 0, as a diagnostic** to produce the evidence in R2, then set aside.

---

## R4 — iOS CocoaPods conflict is the most likely week-eater. `CHANGES PHASE 0 ORDER`

Google's ML Kit iOS pods require `use_frameworks! :linkage => :static`. A number of React Native native modules break under `use_frameworks!`. We are proposing to stack ML Kit + whisper.rn's xcframework + possibly sherpa-onnx in one Podfile.

This is a well-known, entirely undramatic way to lose a week — and it would surface *after* feature code is written, which is the worst time.

**Change:** Phase 0 step one is a **do-nothing iOS build with all three pods linked**, before a single line of feature code. If they cannot coexist, we learn it on day one, and the escape hatch is OPUS-MT via `onnxruntime-react-native` — pure ORT, no ML Kit pod, no `use_frameworks!` requirement. This is the concrete reason the Engine B abstraction earns its keep even though we are not implementing it now.

---

## R5 — Models in a cache directory will silently vanish. `PREVENTS A FIELD FAILURE`

On iOS, `Library/Caches` is **purgeable** — the OS deletes it under storage pressure without asking. Put a 181 MB Whisper model there and it can disappear between Heathrow and Moscow, with the app reporting the pack as installed until the moment it tries to load.

**Change:**
- iOS: `Documents` (or Application Support), with `isExcludedFromBackupKey = true` so a 400 MB pack doesn't wreck iCloud backups.
- Android: `filesDir`, never `cacheDir`; `allowBackup=false` for the model directory.
- Pack verification checks **file existence + SHA-256**, and the offline self-test performs **real inference**, not a stat() call.

---

## R6 — Bluetooth will wreck Russian STT. `PREVENTS A FIELD FAILURE`

A family on a trip wears earbuds. The Bluetooth SCO microphone path is **8 kHz narrowband with aggressive processing** — Whisper's accuracy on it collapses, and Russian collapses further than English.

**Change:** capture is pinned to the **built-in microphone** regardless of connected Bluetooth devices; playback may still route to Bluetooth (A2DP). Never negotiate SCO. If only a headset mic is available, warn explicitly rather than degrade silently.

---

## R7 — Peak memory, not latency, is the likeliest hard failure. `CHANGES THE TIERING RULE`

iOS jetsam kills are **silent** — the app simply disappears mid-sentence. Whisper small + Core ML encoder + ML Kit + the RN JS heap is comfortable on a 6 GB phone and marginal on a 3–4 GB one.

Latency being bad is annoying. Memory being bad means the app vanishes while someone is asking for directions.

**Change:** the benchmark harness records **peak footprint** (`task_vm_info.phys_footprint` on iOS, `Debug.MemoryInfo` on Android), and model tiering keys off **measured peak headroom**, not the RAM figure on a spec sheet. A device passes only if peak stays well under its jetsam limit with margin.

---

## R8 — "Newest Expo SDK" is a risk, not a feature. `CHANGES A VERSION CHOICE`

I casually suggested SDK 57. Checking npm: **57.0.16 is roughly a month old. SDK 55 has 30 patch releases and six months of hardening.**

Community native modules — which is exactly what whisper.rn and a 10-commit ML Kit wrapper are — lag SDK releases, and RN's bridgeless/New Architecture migration is precisely where they break.

**Change:** start on **SDK 55 (55.0.30)**, treat "latest" as a liability, and make the library compatibility matrix the first thing Phase 0 establishes empirically.

---

## R9 — An offline test that doesn't verify it's offline is worthless. `NEW REQUIREMENT`

If the harness records `Russian STT offline: PASS` but the tester forgot to actually enable Airplane Mode, the report is worse than no report — it is false confidence carried onto a plane.

**Change:** before recording any offline result, the harness **attempts a real network request and requires it to fail.** If the network is reachable, offline results are stamped `INVALID — network was reachable`, never `PASS`.

---

## R10 — Force the language. Never auto-detect. `SMALL, IMPORTANT`

Whisper's language auto-detection on short, noisy clips is unreliable, and its characteristic failure is transcribing Russian speech as phonetic English nonsense. The UI already knows the direction.

**Change:** always pass `language: 'en'` or `'ru'` explicitly. Auto-detect is never enabled.

---

## R11 — ML Kit gives no confidence signal. `NEW FEATURE, CHEAP`

There is no way to tell a good ML Kit translation from a bad one. But translation costs 50–200 ms, so we can afford to run it twice.

**Change:** **round-trip back-translation.** Translate en→ru, then ru→en, and show the round-trip result in small text beneath the Russian. The English speaker can see at a glance whether the meaning survived. Costs one extra call, directly serves "correct beats fast", and requires no model we don't already have.

---

## R12 — Google Play Services is a hidden dependency. `ACCEPTED RISK, DOCUMENTED`

ML Kit's Android model download path goes through Play Services, and Play Services updates can invalidate a downloaded model. Almost certainly fine on the family's phones, but it is a dependency OPUS-MT would not have.

**Change:** the offline self-test performs a **real translation**, never merely `isModelDownloaded()`. Reason: `isModelDownloaded()` returning true is not the same claim as "translation works right now."

---

## R13 — Drop the downloader from Phase 0 entirely. `SCOPE CUT`

Phase 0 should not contain a resumable download manager. Bundle the Whisper models in the spike binary or push them with `adb`. This removes an entire class of failure from the spike, and the downloader is Phase 5's problem.

(ML Kit models are the exception — they must be fetched by ML Kit itself over Wi-Fi at setup. That *is* test B.)

---

## R14 — The build pipeline is a hard blocker, and it's not a code problem. `NEEDS YOUR ACTION`

This machine: Windows 11, Node 24.11.0, JDK 21, Git. **No Android SDK, no adb.** And Windows cannot build iOS at all — not with any amount of effort.

| Target | Path | Prerequisite |
|---|---|---|
| Android | Local build → USB sideload | **Android Studio + SDK + platform-tools** (needed anyway for `adb` and logcat, which are how Phase 0 evidence gets collected) |
| iOS | EAS Build (cloud macOS) → TestFlight | **Expo account + Apple Developer Program ($99/yr)** |

There is no free path to running code on an iPhone from Windows. Without an Apple Developer account, Phase 0's entire iOS column stays blank.

Also: Node 24 works (whisper.rn wants ≥ 20.19.4), but **Node 22 LTS** is the safer choice for the RN toolchain.

---

## R15 — I cannot run this spike. `CHANGES WHAT I BUILD`

I can write the harness. I cannot hold a phone, speak Russian into it, or flip Airplane Mode.

**Change:** the spike is built as a **self-reporting benchmark harness**, not a demo app. It collects device model / RAM / OS / arch, times every stage, records peak memory, validates that the network really was unreachable, and emits the PASS/FAIL table as JSON + Markdown to share back. The evidence is produced by the app, not asserted by me.

---

## What does *not* change

- React Native + Expo prebuild as the starting hypothesis
- Whisper **small** as the Russian floor — R1's mitigations address hallucination, not accuracy, and base is still too weak for Russian
- ML Kit as the default translation engine, OPUS-MT as an unimplemented escape hatch
- Native TTS only where provable, Piper as the guarantee
- Push-to-talk before anything continuous
- Airplane Mode as the acceptance gate

## Revised risk order

1. Whisper hallucination in noise (R1)
2. iOS pod integration conflict (R4)
3. Peak memory / silent jetsam kills (R7)
4. Bluetooth microphone (R6)
5. Model storage eviction (R5)
6. Build pipeline blockers (R14)
