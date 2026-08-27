import {
  initWhisper,
  initWhisperVad,
  isUseCoreML,
  isCoreMLAllowFallback,
  libVersion,
  releaseAllWhisper,
  releaseAllWhisperVad,
  type WhisperContext,
  type WhisperVadContext,
} from 'whisper.rn';
import { Directory, File, Paths } from 'expo-file-system';
import type { Lang, SttOutcome, WhisperVariant } from '@core/types';
import { applyGate } from '@core/hallucination';

/** Where the tester pushes model files. See MODELS.md for the adb / Xcode steps. */
export const MODEL_DIR_NAME = 'models';

export const MODEL_FILES: Record<WhisperVariant, string> = {
  small: 'ggml-small-q5_0.bin',
  base: 'ggml-base-q5_0.bin',
};

export const VAD_MODEL_FILE = 'ggml-silero-v5.1.2.bin';

export function modelsDirectory(): Directory {
  return new Directory(Paths.document, MODEL_DIR_NAME);
}

/** whisper.cpp wants a filesystem path, not a file:// URI. */
function toNativePath(uri: string): string {
  return uri.startsWith('file://') ? decodeURI(uri.slice('file://'.length)) : uri;
}

export interface ModelPresence {
  name: string;
  present: boolean;
  sizeBytes: number | null;
  path: string;
}

export function inspectModels(): ModelPresence[] {
  const dir = modelsDirectory();
  const names = [MODEL_FILES.small, MODEL_FILES.base, VAD_MODEL_FILE];
  return names.map((name) => {
    const f = new File(dir, name);
    let present = false;
    let sizeBytes: number | null = null;
    try {
      present = f.exists;
      sizeBytes = present ? f.size : null;
    } catch {
      present = false;
    }
    return { name, present, sizeBytes, path: f.uri };
  });
}

export interface LoadOutcome {
  loadMs: number;
  gpu: boolean;
  reasonNoGPU: string;
  coreMLCompiled: boolean;
  coreMLAllowFallback: boolean;
  libVersion: string;
  variant: WhisperVariant;
  modelSizeBytes: number | null;
}

export interface TranscribeTiming {
  vadMs: number;
  sttMs: number;
  speechMs: number | null;
}

export class WhisperSpeechRecognizer {
  private ctx: WhisperContext | null = null;
  private vad: WhisperVadContext | null = null;
  private variant: WhisperVariant | null = null;

  get isReady() {
    return this.ctx !== null;
  }

  get loadedVariant() {
    return this.variant;
  }

  get hasVad() {
    return this.vad !== null;
  }

  async initialize(variant: WhisperVariant): Promise<LoadOutcome> {
    await this.release();

    const dir = modelsDirectory();
    const modelFile = new File(dir, MODEL_FILES[variant]);
    if (!modelFile.exists) {
      throw new Error(
        `Model ${MODEL_FILES[variant]} is not on the device. Push it to ${dir.uri} — see MODELS.md.`
      );
    }

    const started = Date.now();
    const ctx = await initWhisper({
      filePath: toNativePath(modelFile.uri),
      // Core ML on iOS can fall back to CPU silently. We record which backend
      // actually ran so a latency figure can never be attributed to the wrong one.
      useCoreMLIos: true,
      useGpu: true,
    });
    const loadMs = Date.now() - started;

    this.ctx = ctx;
    this.variant = variant;

    // VAD is optional but strongly preferred: it is the primary defence against
    // Whisper inventing text from silence.
    const vadFile = new File(dir, VAD_MODEL_FILE);
    if (vadFile.exists) {
      try {
        this.vad = await initWhisperVad({
          filePath: toNativePath(vadFile.uri),
          useGpu: false,
          nThreads: 2,
        });
      } catch {
        this.vad = null;
      }
    }

    return {
      loadMs,
      gpu: ctx.gpu,
      reasonNoGPU: ctx.reasonNoGPU,
      coreMLCompiled: isUseCoreML,
      coreMLAllowFallback: isCoreMLAllowFallback,
      libVersion,
      variant,
      modelSizeBytes: modelFile.exists ? modelFile.size : null,
    };
  }

  /**
   * Transcribe a 16 kHz mono WAV.
   *
   * Two decisions here are deliberate and load-bearing:
   *
   *  - `language` is always forced. Whisper's auto-detect on short noisy clips
   *    fails by transcribing Russian as phonetic English nonsense, and the UI
   *    already knows the direction, so there is nothing to gain from guessing.
   *
   *  - `temperature: 0` with `temperatureInc: 0` disables temperature fallback.
   *    Fallback re-decodes failed segments at rising temperature, which is
   *    exactly the mechanism that turns a difficult clip into a fluent invention.
   */
  async transcribe(
    wavUri: string,
    lang: Lang,
    maxThreads?: number
  ): Promise<{ outcome: SttOutcome; timing: TranscribeTiming }> {
    if (!this.ctx) throw new Error('Speech recogniser is not initialised.');
    const path = toNativePath(wavUri);

    let speechMs: number | null = null;
    const vadStart = Date.now();
    if (this.vad) {
      try {
        const segments = await this.vad.detectSpeech(path, {
          threshold: 0.5,
          minSpeechDurationMs: 250,
          minSilenceDurationMs: 100,
          speechPadMs: 30,
        });
        // whisper.cpp reports VAD timestamps in centiseconds.
        speechMs = segments.reduce(
          (acc: number, s: { t0: number; t1: number }) => acc + (s.t1 - s.t0) * 10,
          0
        );
      } catch {
        speechMs = null;
      }
    }
    const vadMs = Date.now() - vadStart;

    // No detected speech means nothing worth sending to Whisper. Stopping here
    // is the single most effective hallucination guard available.
    if (this.vad && speechMs !== null && speechMs === 0) {
      return {
        outcome: {
          text: '',
          avgLogprob: null,
          noSpeechProb: null,
          rejected: true,
          rejectReason: 'no speech detected by VAD',
          transcribeMs: 0,
          backend: this.backendLabel(),
        },
        timing: { vadMs, sttMs: 0, speechMs },
      };
    }

    const sttStart = Date.now();
    const { promise } = this.ctx.transcribe(path, {
      language: lang,
      translate: false,
      temperature: 0,
      temperatureInc: 0,
      maxThreads,
      beamSize: 1,
      bestOf: 1,
    });
    const result = await promise;
    const sttMs = Date.now() - sttStart;

    /**
     * whisper.rn 0.7.3 returns { result, language, segments:[{text,t0,t1}], isAborted }.
     * It does NOT surface avg_logprob or no_speech_prob, even though whisper.cpp
     * computes both. So the confidence gate runs without them and leans on VAD,
     * the blocklist and repetition detection instead. Exposing those two fields
     * is a Phase 1 task — the library is MIT and the data is already there.
     */
    const outcome: SttOutcome = {
      text: (result.result ?? '').trim(),
      avgLogprob: null,
      noSpeechProb: null,
      rejected: false,
      transcribeMs: sttMs,
      backend: this.backendLabel(),
    };

    return { outcome: applyGate(outcome, lang, speechMs), timing: { vadMs, sttMs, speechMs } };
  }

  private backendLabel(): string {
    if (!this.ctx) return 'none';
    if (this.ctx.gpu) return isUseCoreML ? 'coreml/gpu' : 'gpu';
    return `cpu${this.ctx.reasonNoGPU ? ` (${this.ctx.reasonNoGPU})` : ''}`;
  }

  async release(): Promise<void> {
    this.ctx = null;
    this.vad = null;
    this.variant = null;
    await releaseAllWhisper().catch(() => undefined);
    await releaseAllWhisperVad().catch(() => undefined);
  }
}
