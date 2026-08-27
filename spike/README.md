# Phase 0 spike — throwaway de-risking harness

This is **not** the app. It is a self-reporting benchmark harness whose only job is to answer,
with measurements rather than opinions, whether the proposed stack survives Airplane Mode on
real hardware.

Expected outcome: it gets thrown away. What survives is the report and the decisions it forces.

## What it answers

| Question | How |
| --- | --- |
| Does Whisper small load and run on this phone? | Loads the model, records load time, reports which backend actually ran |
| Is Russian STT usable? | 5 Russian travel utterances, push-to-talk, real microphone |
| Is English STT usable? | 5 English utterances |
| Does ML Kit translate offline? | Downloads models over Wi-Fi, then translates with the radio off |
| Does TTS work offline? | Enumerates voices, rejects network-backed ones, then actually speaks |
| Does the whole pipeline hold? | Speech → STT → translate → speak, end to end |
| Was it *really* offline? | Probes the network first, and marks results INVALID if it was reachable |

## Prerequisites

- **Node** — 24.11 works; 22 LTS is the safer choice for the RN toolchain
- **Android** — Android Studio with SDK + platform-tools (`adb` is how models get onto the device
  and how logs come off it)
- **iOS** — no local path from Windows. Needs an Expo account for EAS Build and an Apple
  Developer Program membership for TestFlight. Without those, the iOS column of the report
  stays empty.

## Running it

```powershell
# Android, device connected over USB with debugging on
npx expo run:android

# iOS, from Windows — cloud build, then install via TestFlight
npx eas build --platform ios --profile development
```

Then follow `MODELS.md` to push the Whisper and VAD files onto the device.

Typecheck with `npx tsc --noEmit`.

## The test sequence

Order matters. Steps 1–3 need Wi-Fi; everything after step 4 should be run twice — once
connected, once in Airplane Mode.

1. **Network probe** — establishes whether offline claims can be trusted at all
2. **Setup** — download ML Kit models (Wi-Fi), confirm Whisper files are present
3. **Load Whisper** — pick `small` or `base`, record load time and backend
4. **Speech to text** — select an utterance, hold the button, say it, release
5. **Translation** — EN→RU and RU→EN, with round-trip back-translation shown
6. **Text to speech** — inspect voices first, then speak
7. **Full pipeline** — reuses the last recording, runs the whole chain
8. **Cold start** — force-quit, enable Airplane Mode, relaunch, press this *first*
9. **Export** — writes `.md` and `.json` and opens the share sheet

Run the whole sequence connected, export. Then Airplane Mode, cold start, run it all again,
export again. Two reports, and the comparison between them is the actual deliverable.

## Things it deliberately does not do

- **No download manager.** Models are pushed by hand. A resumable downloader is Phase 5's
  problem and must not be able to make Phase 0 look broken.
- **No Core ML.** iOS could be 2–3× faster with a Core ML encoder, but it adds a 10–60 second
  first-load compile and a second failure mode. First find out whether plain CPU is fast enough.
- **No polished UI.** Deliberately ugly. Nothing here is meant to survive.
- **No conversation history, no analytics, no accounts, no backend.**

## Known gaps, recorded rather than hidden

- **Peak memory is not measured.** It is the measurement that matters most — iOS jetsam kills
  are silent — and it needs a small native module (`task_vm_info.phys_footprint` on iOS,
  `Debug.MemoryInfo` on Android). Phase 1. The report says so rather than substituting total RAM.
- **No confidence scores from Whisper.** whisper.rn 0.7.3 returns `{ result, language, segments,
  isAborted }` and does not surface `avg_logprob` or `no_speech_prob`, even though whisper.cpp
  computes both. So the hallucination gate runs on VAD, a blocklist and repetition detection
  only. Exposing those two fields is a Phase 1 task — the library is MIT and the data is there.
- **ML Kit holds one language pair at a time.** `FastTranslator.prepare()` swaps the loaded
  pair, so each direction change costs a prepare, and round-trip back-translation costs two.
  The harness times `prepare()` separately so we find out whether that matters.
- **The JS network counter proves nothing about native code.** ML Kit, whisper.cpp and Play
  Services all call out below the JS layer. Airplane Mode and the no-INTERNET Android build are
  the only real evidence.

See `../ARCHITECTURE-REVIEW.md` for why each of these is framed this way.
