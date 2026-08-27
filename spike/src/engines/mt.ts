import FastTranslator, { type Languages } from 'fast-mlkit-translate-text';
import type { Lang } from '@core/types';

const LANG_NAME: Record<Lang, Languages> = {
  en: 'English',
  ru: 'Russian',
};

export interface TranslationEngine {
  readonly id: string;
  isPairAvailable(from: Lang, to: Lang): Promise<boolean>;
  ensurePair(from: Lang, to: Lang, allowDownload: boolean): Promise<void>;
  translate(text: string, from: Lang, to: Lang): Promise<string>;
}

export interface TranslateTiming {
  /** Time spent in prepare(), which may swap the loaded model pair. */
  prepareMs: number;
  /** Time spent in translate() alone. */
  translateMs: number;
}

/**
 * ML Kit on-device translation.
 *
 * A real constraint discovered by reading the wrapper rather than the README:
 * `FastTranslator` holds exactly ONE prepared language pair at a time, and
 * `translate()` uses whichever pair was prepared last. So every direction switch
 * costs a `prepare()` call, and round-trip back-translation costs two.
 *
 * We measure prepare() separately for that reason. If it turns out to be
 * expensive, the fix is a first-party native module holding two Translator
 * instances — which is Phase 1 work regardless, since this wrapper is a
 * ten-commit dependency sitting on the critical path.
 */
export class MlKitTranslationEngine implements TranslationEngine {
  readonly id = 'mlkit';
  private preparedPair: string | null = null;

  async isPairAvailable(from: Lang, to: Lang): Promise<boolean> {
    const [a, b] = await Promise.all([
      FastTranslator.isLanguageDownloaded(LANG_NAME[from]),
      FastTranslator.isLanguageDownloaded(LANG_NAME[to]),
    ]);
    return Boolean(a) && Boolean(b);
  }

  async listDownloaded(): Promise<string[]> {
    const models = await FastTranslator.getDownloadedLanguageModels();
    return Array.isArray(models) ? models.map(String) : [];
  }

  /**
   * `allowDownload` is deliberately explicit. During an offline test it is false,
   * so a missing model surfaces as a clear failure instead of a silent attempt
   * to reach Google's servers.
   */
  async ensurePair(from: Lang, to: Lang, allowDownload: boolean): Promise<void> {
    const key = `${from}->${to}`;
    if (this.preparedPair === key) return;

    if (!allowDownload) {
      const available = await this.isPairAvailable(from, to);
      if (!available) {
        throw new Error(
          `Russian offline language pack is not installed (${LANG_NAME[from]} → ${LANG_NAME[to]}).`
        );
      }
    }

    await FastTranslator.prepare({
      source: LANG_NAME[from],
      target: LANG_NAME[to],
      downloadIfNeeded: allowDownload,
    });
    this.preparedPair = key;
  }

  async translate(text: string, from: Lang, to: Lang): Promise<string> {
    await this.ensurePair(from, to, false);
    const out = await FastTranslator.translate(text);
    if (typeof out !== 'string' || out.trim().length === 0) {
      throw new Error('Translation returned nothing.');
    }
    return out;
  }

  /** Translate with prepare() and translate() timed separately. */
  async translateTimed(
    text: string,
    from: Lang,
    to: Lang,
    allowDownload = false
  ): Promise<{ text: string; timing: TranslateTiming }> {
    const t0 = Date.now();
    await this.ensurePair(from, to, allowDownload);
    const t1 = Date.now();
    const out = await FastTranslator.translate(text);
    const t2 = Date.now();
    if (typeof out !== 'string' || out.trim().length === 0) {
      throw new Error('Translation returned nothing.');
    }
    return { text: out, timing: { prepareMs: t1 - t0, translateMs: t2 - t1 } };
  }

  /**
   * ML Kit exposes no confidence score, so we buy a sanity signal instead:
   * translate forward, then translate the result back. If the round trip has
   * drifted, the English speaker can see it at a glance. Costs one extra
   * prepare + translate, and needs no model we don't already have.
   */
  async roundTrip(
    text: string,
    from: Lang,
    to: Lang
  ): Promise<{ forward: string; back: string; forwardMs: number; backMs: number }> {
    const fwd = await this.translateTimed(text, from, to);
    const back = await this.translateTimed(fwd.text, to, from);
    return {
      forward: fwd.text,
      back: back.text,
      forwardMs: fwd.timing.prepareMs + fwd.timing.translateMs,
      backMs: back.timing.prepareMs + back.timing.translateMs,
    };
  }

  /** Setup-time only. Requires network by definition. */
  async downloadBothLanguages(onProgress?: (msg: string) => void): Promise<void> {
    for (const lang of ['en', 'ru'] as Lang[]) {
      const name = LANG_NAME[lang];
      const already = await FastTranslator.isLanguageDownloaded(name);
      if (already) {
        onProgress?.(`${name}: already installed`);
        continue;
      }
      onProgress?.(`${name}: downloading…`);
      await FastTranslator.downloadLanguageModel(name);
      onProgress?.(`${name}: installed`);
    }
  }

  async deleteBothLanguages(): Promise<void> {
    await FastTranslator.deleteLanguageModel(LANG_NAME.en);
    await FastTranslator.deleteLanguageModel(LANG_NAME.ru);
    this.preparedPair = null;
  }
}
