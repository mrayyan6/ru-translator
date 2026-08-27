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
  private unlocked = false;

  /**
   * Android Chrome refuses `speak()` unless speech synthesis has been started
   * from a user gesture at least once, and it refuses silently — no error, no
   * audio, no events. Our translation arrives after an await, so by the time
   * we auto-speak the gesture is long gone.
   *
   * Speaking one empty utterance from inside the tap that starts a translation
   * lifts the restriction for the rest of the session. Call it from a real
   * event handler, synchronously, before any awaits.
   */
  unlock(): void {
    if (this.unlocked || !('speechSynthesis' in globalThis)) return;
    this.unlocked = true;
    try {
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      speechSynthesis.speak(u);
      speechSynthesis.cancel();
    } catch {
      /* nothing to recover from; the real speak() will report any problem */
    }
  }

  /**
   * Voice lists populate asynchronously, and Chrome in particular returns an
   * empty array on the first call. Wait for `voiceschanged`, with a timeout so
   * a browser that never fires it doesn't hang the setup screen.
   */
  /**
   * Android populates the voice list late and sometimes without ever firing
   * `voiceschanged`, so wait for the event but also poll, and give it longer
   * than feels necessary. An empty list here reads as "no TTS on this device",
   * which is a discouraging and usually wrong thing to tell someone.
   */
  async initialize(timeoutMs = 6000): Promise<void> {
    if (!('speechSynthesis' in globalThis)) {
      throw new Error('This browser has no speech synthesis support.');
    }

    const immediate = speechSynthesis.getVoices();
    if (immediate.length > 0) {
      this.voices = immediate;
      return;
    }

    await new Promise<void>((resolve) => {
      const finish = () => {
        speechSynthesis.removeEventListener('voiceschanged', finish);
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      };
      const poll = setInterval(() => {
        if (speechSynthesis.getVoices().length > 0) finish();
      }, 250);
      const timer = setTimeout(finish, timeoutMs);
      speechSynthesis.addEventListener('voiceschanged', finish);
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

  /**
   * `localService` is a preference here, not a filter.
   *
   * It was a filter, and that was wrong: Android Chrome reports
   * `localService: false` for every voice it exposes, including ones the
   * Android TTS engine synthesises entirely on-device. Trusting it there means
   * rejecting every voice on the phone and never speaking at all — a worse
   * outcome than trying a voice that might turn out to need the network.
   *
   * So: prefer a voice that claims to be local, fall back to any voice for the
   * language, and let the Airplane Mode test settle the question empirically.
   * That was always the plan for iOS, which exposes no such flag either.
   */
  pickOfflineVoice(lang: Lang): SpeechSynthesisVoice | null {
    const prefix = lang === 'ru' ? 'ru' : 'en';
    const matching = this.voices.filter((v) => (v.lang ?? '').toLowerCase().startsWith(prefix));
    if (matching.length === 0) return null;

    const rank = (v: SpeechSynthesisVoice) => {
      const exact =
        (v.lang ?? '').toLowerCase().replace('_', '-') === LOCALE[lang].toLowerCase() ? 2 : 0;
      return (v.localService ? 4 : 0) + exact + (v.default ? 1 : 0);
    };
    return [...matching].sort((a, b) => rank(b) - rank(a))[0] ?? null;
  }

  /** True when the chosen voice claims to be device-local. Advisory only. */
  isVoiceClaimedLocal(lang: Lang): boolean {
    return this.pickOfflineVoice(lang)?.localService === true;
  }

  diagnose(lang: Lang): string | null {
    const prefix = lang === 'ru' ? 'ru' : 'en';
    const matching = this.voices.filter((v) => (v.lang ?? '').toLowerCase().startsWith(prefix));
    if (this.voices.length === 0) {
      return 'The browser reported no voices at all. On Android, install or enable a text-to-speech engine under Settings → System → Languages & input → Text-to-speech output.';
    }
    if (matching.length === 0) {
      return prefix === 'ru'
        ? 'No Russian voice on this device. On Android install Russian under Settings → System → Languages & input → Text-to-speech output → your engine → Install voice data. On iOS use Settings → Accessibility → Spoken Content → Voices.'
        : 'No English voice on this device.';
    }
    // Voices exist, so we will try them. Whether they truly work offline is
    // decided by the Airplane Mode test, not by a flag.
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
