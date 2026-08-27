import type { AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type { Lang, SttOutcome, WhisperVariant } from '@core/types';
import { applyGate } from '@core/hallucination';
import { hasCachedModel } from '../modelCache';
import { peakAmplitude } from '../audio';
import { getTransformers } from '../transformersEnv';

export const WHISPER_MODELS: Record<WhisperVariant, string> = {
  base: 'onnx-community/whisper-base',
  small: 'onnx-community/whisper-small',
};

/**
 * Inference cannot actually be cancelled once it is inside WASM or WebGPU, but
 * rejecting still matters: without it a stalled run leaves the UI waiting
 * forever with no message, and the tab eventually dies taking the evidence with
 * it. A rejection at least names the failure.
 */
const TRANSCRIBE_TIMEOUT_MS = 60000;

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} did not finish within ${Math.round(ms / 1000)}s.`)),
        ms
      )
    ),
  ]);
}

/** transformers.js wants the language spelled out, not the ISO code. */
const WHISPER_LANG: Record<Lang, string> = { en: 'english', ru: 'russian' };

export interface SttLoadProgress {
  file: string;
  progress: number;
  loaded: number;
  total: number;
}

export interface WebSttResult {
  outcome: SttOutcome;
  sttMs: number;
  /** Which engine produced this — the two have very different characteristics. */
  engine: 'web-speech-on-device' | 'whisper-transformers';
}

export interface SpeechRecognizer {
  readonly id: string;
  isAvailable(lang: Lang): Promise<{ available: boolean; reason: string }>;
  transcribe(samples: Float32Array, lang: Lang): Promise<WebSttResult>;
}

/* ------------------------------------------------------------------ Whisper */

export class WhisperWebRecognizer implements SpeechRecognizer {
  readonly id = 'whisper-transformers';
  private pipe: AutomaticSpeechRecognitionPipeline | null = null;
  private variant: WhisperVariant | null = null;
  private device: 'webgpu' | 'wasm' = 'wasm';
  private dtype: string | null = null;

  get loadedVariant() {
    return this.variant;
  }
  get activeDevice() {
    return this.device;
  }
  get activeDtype() {
    return this.dtype;
  }

  async isAvailable(): Promise<{ available: boolean; reason: string }> {
    return this.pipe
      ? { available: true, reason: `loaded (${this.variant}, ${this.device})` }
      : { available: false, reason: 'model not loaded' };
  }

  async isCached(variant: WhisperVariant): Promise<boolean> {
    return hasCachedModel(WHISPER_MODELS[variant]);
  }

  /**
   * Quantisations to try, in order, falling through on session-creation failure.
   *
   * `q8` first because it is by far the smallest download (~77 MB for base
   * against ~291 MB for fp32) and is the well-trodden path on this runtime.
   * `fp32` is the documented escape hatch: quantised Whisper decoders fail to
   * create a session on some ONNX Runtime builds with "Missing required
   * scale ... MatMulNBits", and fp32 is unaffected.
   *
   * Trying rather than guessing costs one extra download in the bad case and
   * saves a whole test cycle — which on a phone in another room is the more
   * expensive resource.
   */
  private static readonly DTYPE_CANDIDATES = ['q8', 'fp32'] as const;

  async load(
    variant: WhisperVariant,
    device: 'webgpu' | 'wasm',
    onProgress?: (p: SttLoadProgress) => void,
    /**
     * Called the moment an attempt fails, before the next one starts.
     *
     * This matters more than it looks: the fallback attempt downloads hundreds
     * of megabytes and can get the tab killed for memory, taking the error
     * message with it. Reporting the failure as it happens means the reason is
     * already written down when that occurs.
     */
    onAttempt?: (message: string) => void
  ): Promise<{ ms: number; modelId: string; device: string; dtype: string; attempts: string[] }> {
    const modelId = WHISPER_MODELS[variant];
    const started = performance.now();
    const { pipeline } = await getTransformers();

    // `pipeline` is declared with one overload per task and a correspondingly
    // enormous return union. Resolving it here exceeds TypeScript's union
    // complexity limit, so narrow it to the shape we actually use. The result
    // is still asserted to the pipeline type below.
    const createPipeline = pipeline as unknown as (
      task: string,
      model: string,
      options?: any
    ) => Promise<unknown>;

    const attempts: string[] = [];
    let lastError: unknown = null;

    for (const dtype of WhisperWebRecognizer.DTYPE_CANDIDATES) {
      try {
        this.pipe = (await createPipeline('automatic-speech-recognition', modelId, {
          device,
          dtype,
          progress_callback: (data: any) => {
            if (data?.status === 'progress') {
              onProgress?.({
                file: `${dtype} ${data.file ?? ''}`,
                progress: data.progress ?? 0,
                loaded: data.loaded ?? 0,
                total: data.total ?? 0,
              });
            }
          },
        })) as AutomaticSpeechRecognitionPipeline;

        attempts.push(`${dtype}: ok`);
        this.variant = variant;
        this.device = device;
        this.dtype = dtype;
        return { ms: performance.now() - started, modelId, device, dtype, attempts };
      } catch (e: any) {
        const message = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 400);
        attempts.push(`${dtype}: FAILED (${message})`);
        onAttempt?.(`Whisper ${dtype} FAILED: ${message}`);
        lastError = e;
      }
    }

    throw new Error(
      `Could not create a Whisper session with any quantisation. Tried ${attempts.join(
        ' | '
      )}. Last error: ${String((lastError as any)?.message ?? lastError)}`
    );
  }

  /**
   * Run one throwaway inference on a second of silence.
   *
   * The first call into a freshly created session pays for shader and kernel
   * compilation, which on WebGPU can dwarf the inference itself. Paying it at
   * load time means the first thing someone actually says is not the slowest
   * thing the app ever does, and it separates compile cost from inference cost
   * in the report instead of hiding one inside the other.
   */
  async warmUp(lang: Lang = 'en'): Promise<number> {
    if (!this.pipe) throw new Error('Whisper is not loaded.');
    const silence = new Float32Array(16000);
    const started = performance.now();
    await this.pipe(silence, {
      language: WHISPER_LANG[lang],
      task: 'transcribe',
      temperature: 0,
      do_sample: false,
      return_timestamps: false,
    });
    return performance.now() - started;
  }

  /**
   * Language is always forced and temperature pinned to zero.
   *
   * Auto-detection on a short noisy clip fails by transcribing Russian as
   * phonetic English, and temperature fallback — re-decoding a difficult
   * segment at rising temperature — is the exact mechanism that turns a hard
   * clip into a confident invention. The UI knows the direction; there is
   * nothing to gain from letting the model guess.
   */
  async transcribe(samples: Float32Array, lang: Lang): Promise<WebSttResult> {
    if (!this.pipe) throw new Error('Whisper is not loaded.');

    // A dead or muted microphone is a common and confusing failure. Catching it
    // here gives a real message instead of a hallucinated sentence.
    const peak = peakAmplitude(samples);
    if (peak < 0.005) {
      return {
        outcome: {
          text: '',
          avgLogprob: null,
          noSpeechProb: null,
          rejected: true,
          rejectReason: `microphone produced near-silence (peak ${peak.toFixed(4)})`,
          transcribeMs: 0,
          backend: this.device,
        },
        sttMs: 0,
        engine: 'whisper-transformers',
      };
    }

    const started = performance.now();
    // No `chunk_length_s`. Whisper already works on a single 30-second window,
    // and setting it engages the chunking/striding path for audio that does not
    // need it — pure overhead for push-to-talk clips.
    const out: any = await withTimeout(
      this.pipe(samples, {
        language: WHISPER_LANG[lang],
        task: 'transcribe',
        temperature: 0,
        do_sample: false,
        return_timestamps: false,
      }) as Promise<any>,
      TRANSCRIBE_TIMEOUT_MS,
      'Transcription'
    );
    const sttMs = performance.now() - started;

    const text = (Array.isArray(out) ? out[0]?.text : out?.text) ?? '';
    const speechMs = (samples.length / 16000) * 1000;

    const outcome: SttOutcome = {
      text: String(text).trim(),
      // transformers.js does not surface avg_logprob or no_speech_prob either,
      // so the gate runs on the blocklist, repetition and duration checks.
      avgLogprob: null,
      noSpeechProb: null,
      rejected: false,
      transcribeMs: sttMs,
      backend: this.device,
    };

    return { outcome: applyGate(outcome, lang, speechMs), sttMs, engine: 'whisper-transformers' };
  }

  async dispose() {
    await (this.pipe as any)?.dispose?.().catch?.(() => undefined);
    this.pipe = null;
    this.variant = null;
  }
}

/* ------------------------------------------- Chrome on-device Web Speech API */

type AvailabilityStatus = 'available' | 'downloadable' | 'downloading' | 'unavailable';

interface OnDeviceSpeechRecognitionCtor {
  new (): any;
  available?(options: { langs: string[]; processLocally: boolean }): Promise<AvailabilityStatus>;
  install?(options: { langs: string[]; processLocally: boolean }): Promise<boolean>;
}

function getSpeechRecognitionCtor(): OnDeviceSpeechRecognitionCtor | null {
  const w = globalThis as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Chrome's on-device Web Speech API.
 *
 * Worth having because on Android it hands us the platform recogniser: fast,
 * accurate on Russian, free, and with no model for us to ship. Crucially it
 * only counts if `processLocally` is honoured — plain `webkitSpeechRecognition`
 * streams audio to a server, which this app must never do.
 *
 * So availability is gated on `available({ processLocally: true })` returning
 * a real answer. A browser that lacks that method (Safari today) is treated as
 * unavailable rather than being trusted, because there is no way to verify
 * where its audio goes.
 */
export class OnDeviceWebSpeechRecognizer implements SpeechRecognizer {
  readonly id = 'web-speech-on-device';

  static supportsLocalProcessing(): boolean {
    const Ctor = getSpeechRecognitionCtor();
    return typeof Ctor?.available === 'function' && typeof Ctor?.install === 'function';
  }

  async isAvailable(lang: Lang): Promise<{ available: boolean; reason: string }> {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return { available: false, reason: 'SpeechRecognition not implemented' };
    if (!OnDeviceWebSpeechRecognizer.supportsLocalProcessing()) {
      return {
        available: false,
        reason:
          'No available()/install() — cannot verify recognition is on-device, so treating as unusable',
      };
    }
    try {
      const status = await Ctor.available!({
        langs: [lang === 'ru' ? 'ru-RU' : 'en-US'],
        processLocally: true,
      });
      return {
        available: status === 'available',
        reason: `availability: ${status}`,
      };
    } catch (e: any) {
      return { available: false, reason: `availability check failed: ${e?.message ?? e}` };
    }
  }

  /** Downloads the platform language pack. Needs a network, once. */
  async install(lang: Lang): Promise<boolean> {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor?.install) return false;
    return Ctor.install({ langs: [lang === 'ru' ? 'ru-RU' : 'en-US'], processLocally: true });
  }

  /**
   * This engine listens live rather than accepting samples, so the recorded
   * buffer is unused. The harness calls `listen()` directly; this exists to
   * satisfy the shared interface and fails loudly if called by mistake.
   */
  async transcribe(): Promise<WebSttResult> {
    throw new Error('OnDeviceWebSpeechRecognizer listens live — call listen() instead.');
  }

  async listen(lang: Lang, signal?: AbortSignal): Promise<WebSttResult> {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) throw new Error('SpeechRecognition not implemented in this browser.');

    const recognition = new Ctor();
    recognition.lang = lang === 'ru' ? 'ru-RU' : 'en-US';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.processLocally = true;

    const started = performance.now();

    return await new Promise<WebSttResult>((resolve, reject) => {
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        try {
          recognition.stop();
        } catch {
          /* already stopped */
        }
        fn();
      };

      recognition.onresult = (event: any) => {
        const text = event.results?.[0]?.[0]?.transcript ?? '';
        const sttMs = performance.now() - started;
        const outcome: SttOutcome = {
          text: String(text).trim(),
          avgLogprob: null,
          noSpeechProb: null,
          rejected: false,
          transcribeMs: sttMs,
          backend: 'platform-on-device',
        };
        finish(() =>
          resolve({
            // The platform recogniser is not autoregressive in the way Whisper
            // is, so it does not invent sentences from silence. The gate still
            // runs: an empty result is still worth rejecting.
            outcome: applyGate(outcome, lang, null),
            sttMs,
            engine: 'web-speech-on-device',
          })
        );
      };

      recognition.onerror = (event: any) =>
        finish(() => reject(new Error(`Speech recognition error: ${event.error ?? 'unknown'}`)));

      recognition.onend = () =>
        finish(() => reject(new Error('Recognition ended without producing a result.')));

      signal?.addEventListener('abort', () => finish(() => reject(new Error('Cancelled.'))));

      recognition.start();
    });
  }
}
