# Getting model files onto the device

Phase 0 deliberately has **no download manager**. Models are pushed onto the device by hand.
That removes an entire class of failure from the spike — a resumable downloader is Phase 5's
problem, and it must not be able to make Phase 0 look broken.

The one exception is ML Kit, whose models can only be fetched by ML Kit itself. That download
happens in-app, over Wi-Fi, via the button in step 2 — and testing that it survives Airplane
Mode afterwards **is** test B.

---

## 1. Download the Whisper files on this PC

```powershell
$dst = "$env:USERPROFILE\Downloads\ru-spike-models"
New-Item -ItemType Directory -Force $dst | Out-Null

# Whisper small, q5_0 — the Russian floor (~181 MB)
Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_0.bin" `
  -OutFile "$dst\ggml-small-q5_0.bin"

# Whisper base, q5_0 — the comparison model (~57 MB)
Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_0.bin" `
  -OutFile "$dst\ggml-base-q5_0.bin"

# Silero VAD — small, and the primary hallucination guard (~2 MB)
Invoke-WebRequest -Uri "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" `
  -OutFile "$dst\ggml-silero-v5.1.2.bin"
```

If a URL 404s, browse `https://huggingface.co/ggerganov/whisper.cpp/tree/main` and take the
current filename — quantisation naming changes occasionally.

**Do not skip the VAD model.** Without it the app still runs, but the strongest defence against
Whisper inventing text from silence is switched off, and the report will say so.

---

## 2. Android — push with adb

The app prints its exact model directory in step 2 of the UI. It will look like:

```
file:///data/user/0/com.rayyan.ruspike/files/models
```

Since that path is app-private, push via `run-as`:

```powershell
$pkg = "com.rayyan.ruspike"
$src = "$env:USERPROFILE\Downloads\ru-spike-models"

adb push "$src\ggml-small-q5_0.bin"     /data/local/tmp/
adb push "$src\ggml-base-q5_0.bin"      /data/local/tmp/
adb push "$src\ggml-silero-v5.1.2.bin"  /data/local/tmp/

adb shell "run-as $pkg mkdir -p files/models"
adb shell "run-as $pkg sh -c 'cat /data/local/tmp/ggml-small-q5_0.bin > files/models/ggml-small-q5_0.bin'"
adb shell "run-as $pkg sh -c 'cat /data/local/tmp/ggml-base-q5_0.bin > files/models/ggml-base-q5_0.bin'"
adb shell "run-as $pkg sh -c 'cat /data/local/tmp/ggml-silero-v5.1.2.bin > files/models/ggml-silero-v5.1.2.bin'"

adb shell rm /data/local/tmp/ggml-*.bin
```

Then press **Re-check Whisper model files** in the app. `run-as` needs a debuggable build,
which a dev-client build is.

---

## 3. iOS — copy via the Files app

There is no `adb` equivalent, and no Mac here, so:

1. In `app.json`, the spike does **not** set `UIFileSharingEnabled`. For Phase 0, add it:
   `"ios": { "infoPlist": { "UIFileSharingEnabled": true, "LSSupportsOpeningDocumentsInPlace": true } }`
   and rebuild. This exposes the app's Documents directory in the Files app.
2. AirDrop / iCloud the three `.bin` files to the iPhone.
3. In **Files → On My iPhone → RU Spike**, create a folder named exactly `models` and move the
   three files into it.
4. Press **Re-check Whisper model files**.

Remove `UIFileSharingEnabled` before anything ships beyond the spike.

---

## 4. Storage locations, and why

Models go in **Documents**, never Caches.

Expo's own SDK 55 documentation describes `Paths.cache` as *"files that can be deleted by the
system when the device runs low on storage"*. A 181 MB model in that directory can be silently
removed by iOS, and the failure would surface as a broken app in Russia rather than a failed
test at home.

For the real app (Phase 5) the model directory additionally needs
`isExcludedFromBackupKey = true` on iOS, so a 400 MB pack doesn't wreck the user's iCloud
backup, and `allowBackup=false` on Android.

---

## 5. Model reference

| File | Size | Purpose | Licence |
| --- | --- | --- | --- |
| `ggml-small-q5_0.bin` | ~181 MB | STT, both languages. The Russian floor. | MIT (OpenAI) |
| `ggml-base-q5_0.bin` | ~57 MB | STT comparison. Good English, weak Russian. | MIT (OpenAI) |
| `ggml-silero-v5.1.2.bin` | ~2 MB | Voice activity detection. | MIT |
| ML Kit `en` + `ru` | ~30 MB each | Translation. Downloaded in-app by ML Kit. | Google ML Kit ToS |

On iOS, Whisper can additionally use a Core ML encoder (`.mlmodelc`, ~150 MB for small) for a
2–3× speedup. It is deliberately **not** part of Phase 0: it adds a first-load compile step of
10–60 seconds and a second failure mode, and the first thing worth learning is whether plain
CPU inference is fast enough. If it isn't, Core ML is the next thing to try — and the report's
`backend=` field will already tell us which path actually ran.
