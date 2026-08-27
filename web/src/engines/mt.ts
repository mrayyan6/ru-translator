import type { TranslationPipeline } from '@huggingface/transformers';
import type { Lang } from '@core/types';
import { hasCachedModel } from '../modelCache';
import { getTransformers } from '../transformersEnv';

/**
 * Bilingual OPUS-MT models, one per direction.
 *
 * Bilingual rather than multilingual on purpose: opus-mt-en-ru is a small model
 * that does one thing, so it beats a general multilingual model of the same
 * size on this pair, and two of them still cost less than one NLLB.
 *
 * `onnx-community/opus-mt-{en-ru,ru-en}` are equivalent alternates if these
 * ever disappear.
 */
export const MT_MODELS: Record<string, string> = {
  'en->ru': 'Xenova/opus-mt-en-ru',
  'ru->en': 'Xenova/opus-mt-ru-en',
};

export interface MtLoadProgress {
  file: string;
  progress: number;
  loaded: number;
  total: number;
}

export interface TranslateResult {
  text: string;
  ms: number;
}

export class WebTranslationEngine {
  readonly id = 'opus-mt-onnx';
  private pipelines = new Map<string, TranslationPipeline>();
  private dtypes = new Map<string, string>();

  private key(from: Lang, to: Lang) {
    return `${from}->${to}`;
  }

  modelIdFor(from: Lang, to: Lang): string {
    const id = MT_MODELS[this.key(from, to)];
    if (!id) throw new Error(`No translation model configured for ${from} → ${to}.`);
    return id;
  }

  async isPairCached(from: Lang, to: Lang): Promise<boolean> {
    return hasCachedModel(this.modelIdFor(from, to));
  }

  /**
   * Both directions stay loaded once warmed. Unlike the native ML Kit wrapper,
   * which holds one prepared pair at a time and pays a swap on every direction
   * change, keeping two pipelines here costs only memory — so direction
   * switching and round-trip back-translation are both free.
   */
  async load(
    from: Lang,
    to: Lang,
    onProgress?: (p: MtLoadProgress) => void,
    /** Reports a failed attempt immediately, before the larger fallback starts. */
    onAttempt?: (message: string) => void
  ): Promise<{ ms: number; modelId: string; dtype: string; attempts: string[] }> {
    const key = this.key(from, to);
    const modelId = this.modelIdFor(from, to);
    if (this.pipelines.has(key)) {
      return { ms: 0, modelId, dtype: this.dtypes.get(key) ?? 'unknown', attempts: ['cached'] };
    }

    const started = performance.now();
    const { pipeline } = await getTransformers();

    // `pipeline` is declared with one overload per task and a correspondingly
    // enormous return union. Resolving it here exceeds TypeScript's union
    // complexity limit, so narrow it to the shape we actually use. The result
    // is still asserted to TranslationPipeline below.
    const createPipeline = pipeline as unknown as (
      task: string,
      model: string,
      options?: any
    ) => Promise<unknown>;

    // Same fallback as the speech model, and for the same reason: quantised
    // weights fail session creation on some ONNX Runtime builds, and finding
    // that out by trying beats finding it out on the phone.
    const attempts: string[] = [];
    let lastError: unknown = null;

    for (const dtype of ['q8', 'fp32']) {
      try {
        // The options object is deliberately untyped. transformers.js declares
        // `pipeline` with one overload per task, and letting TypeScript resolve
        // a narrowed dtype against that set produces "union type too complex to
        // represent" — a checker limit, not a real error.
        const options: any = {
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
        };
        const pipe = (await createPipeline('translation', modelId, options)) as TranslationPipeline;

        attempts.push(`${dtype}: ok`);
        this.pipelines.set(key, pipe);
        this.dtypes.set(key, dtype);
        return { ms: performance.now() - started, modelId, dtype, attempts };
      } catch (e: any) {
        const message = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 400);
        attempts.push(`${dtype}: FAILED (${message})`);
        onAttempt?.(`${modelId} ${dtype} FAILED: ${message}`);
        lastError = e;
      }
    }

    throw new Error(
      `Could not create a translation session for ${modelId}. Tried ${attempts.join(
        ' | '
      )}. Last error: ${String((lastError as any)?.message ?? lastError)}`
    );
  }

  async translate(text: string, from: Lang, to: Lang): Promise<TranslateResult> {
    const key = this.key(from, to);
    const pipe = this.pipelines.get(key);
    if (!pipe) {
      throw new Error(
        `Russian offline language pack is not installed (${from} → ${to}). Load it while online first.`
      );
    }
    const started = performance.now();
    const out: any = await pipe(text);
    const ms = performance.now() - started;
    const translated = Array.isArray(out) ? out[0]?.translation_text : out?.translation_text;
    if (typeof translated !== 'string' || translated.trim() === '') {
      throw new Error('Translation returned nothing.');
    }
    return { text: translated, ms };
  }

  /**
   * Forward then back. ML Kit and OPUS-MT both give a translation with no
   * confidence attached, so we buy a signal instead: if the round trip comes
   * back mangled, the English speaker can see it without reading Cyrillic.
   */
  async roundTrip(text: string, from: Lang, to: Lang) {
    const forward = await this.translate(text, from, to);
    const back = await this.translate(forward.text, to, from);
    return { forward: forward.text, back: back.text, forwardMs: forward.ms, backMs: back.ms };
  }

  isLoaded(from: Lang, to: Lang) {
    return this.pipelines.has(this.key(from, to));
  }

  async dispose() {
    for (const pipe of this.pipelines.values()) {
      await (pipe as any).dispose?.().catch?.(() => undefined);
    }
    this.pipelines.clear();
  }
}
