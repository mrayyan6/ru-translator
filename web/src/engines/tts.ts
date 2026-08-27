import type { Lang, VoiceInfo } from '@core/types';

const LOCALE: Record<Lang, string> = { en: 'en-US', ru: 'ru-RU' };

export interface WebSpeakOutcome {
  firstAudioMs: number;
  totalMs: number;
  voiceName: string;
  /** localService === true means the voice is synthesised on the device. */
  localService: boolean;
}

/**
 * Browser text-to-speech.
 *
 * The Web Speech API turns out to solve the problem I thought it couldn't:
 * `SpeechSynthesisVoice.localService` says whether a voice is synthesised
 * locally or fetched from a server. That is the browser equivalent of Android's
 * `isNetworkConnectionRequired`, and it lets us reject network-backed voices
 * before ever speaking — which is exactly the guarantee this app needs.
 */
export class WebSpeechSynthesizer {
  private voices: SpeechSynthesisVoice[] = [];

  /**
   * Voice lists populate asynchronously, and Chrome in particular returns an
   * empty array on the first call. Wait for `voiceschanged`, with a timeout so
   * a browser that never fires it doesn't hang the setup screen.
   */
  async initialize(timeoutMs = 3000): Promise<void> {
    if (!('speechSynthesis' in globalThis)) {
      throw new Error('This browser has no speech synthesis support.');
    }

    const immediate = speechSynthesis.getVoices();
    if (immediate.length > 0) {
      this.voices = immediate;
      return;
    }

    await new Promise<void>((resolve) => {
      const done = () => {
        speechSynthesis.removeEventListener('voiceschanged', done);
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      speechSynthesis.addEventListener('voiceschanged', done);
    });

    this.voices = speechSynthesis.getVoices();
  }

  listVoices(): VoiceInfo[] {
    return this.voices.map((v) => ({
      id: v.voiceURI,
      name: v.name,
      language: v.lang,
      // A remote voice is precisely a voice that needs the network.
      networkConnectionRequired: v.localService ? false : true,
      notInstalled: null,
      quality: v.default ? 'default' : undefined,
    }));
  }

  pickOfflineVoice(lang: Lang): SpeechSynthesisVoice | null {
    const prefix = lang === 'ru' ? 'ru' : 'en';
    const matching = this.voices.filter((v) => (v.lang ?? '').toLowerCase().startsWith(prefix));
    const local = matching.filter((v) => v.localService);
    if (local.length === 0) return null;

    const exact = local.filter((v) => (v.lang ?? '').toLowerCase().replace('_', '-') === LOCALE[lang].toLowerCase());
    const pool = exact.length > 0 ? exact : local;
    const preferred = pool.find((v) => v.default);
    return preferred ?? pool[0];
  }

  diagnose(lang: Lang): string | null {
    const prefix = lang === 'ru' ? 'ru' : 'en';
    const matching = this.voices.filter((v) => (v.lang ?? '').toLowerCase().startsWith(prefix));
    if (this.voices.length === 0) {
      return 'The browser reported no voices at all. On Android this sometimes means no TTS engine is installed.';
    }
    if (matching.length === 0) {
      return `No ${prefix} voice on this device. On iOS add one under Settings → Accessibility → Spoken Content → Voices.`;
    }
    if (matching.every((v) => !v.localService)) {
      return `Found ${matching.length} ${prefix} voice(s), but all are remote (localService=false) and will not work offline.`;
    }
    return null;
  }

  async speak(text: string, lang: Lang): Promise<WebSpeakOutcome> {
    const voice = this.pickOfflineVoice(lang);
    if (!voice) throw new Error(this.diagnose(lang) ?? `No usable ${lang} voice.`);

    speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang || LOCALE[lang];
    utterance.rate = 0.95;

    const started = performance.now();
    let firstAudioAt: number | null = null;

    return await new Promise<WebSpeakOutcome>((resolve, reject) => {
      const finish = (err?: string) => {
        clearTimeout(timer);
        clearInterval(keepAlive);
        if (err) reject(new Error(err));
        else
          resolve({
            firstAudioMs: (firstAudioAt ?? performance.now()) - started,
            totalMs: performance.now() - started,
            voiceName: voice.name,
            localService: voice.localService,
          });
      };

      utterance.onstart = () => {
        if (firstAudioAt === null) firstAudioAt = performance.now();
      };
      utterance.onend = () => finish();
      utterance.onerror = (e) => finish(`Speech synthesis failed: ${e.error ?? 'unknown'}`);

      // A network-backed voice tends to stall silently offline rather than
      // erroring, so a timeout is the only way that failure ever surfaces.
      const timer = setTimeout(() => {
        speechSynthesis.cancel();
        finish('No audio within 15s — the selected voice is most likely network-backed.');
      }, 15000);

      // Chrome stops long utterances after ~15s unless the queue is nudged.
      const keepAlive = setInterval(() => {
        if (speechSynthesis.speaking) {
          speechSynthesis.pause();
          speechSynthesis.resume();
        }
      }, 10000);

      speechSynthesis.speak(utterance);
    });
  }

  stop() {
    if ('speechSynthesis' in globalThis) speechSynthesis.cancel();
  }
}
