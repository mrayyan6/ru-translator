import { Platform } from 'react-native';
import Tts, { type TtsVoice } from 'react-native-tts';
import type { Lang, VoiceInfo } from '@core/types';

const LOCALE: Record<Lang, string> = { en: 'en-US', ru: 'ru-RU' };

export interface SpeakOutcome {
  /** Time from calling speak() to the first tts-start event. */
  firstAudioMs: number;
  /** Time until tts-finish. */
  totalMs: number;
  voiceId: string | null;
  /** Whether the chosen voice is known to work without a network. */
  offlineCapable: boolean | 'unknown';
}

/**
 * Native text-to-speech, with the offline question treated as something to be
 * proven rather than assumed.
 *
 * Android exposes `networkConnectionRequired` and `notInstalled` per voice, so
 * we can reject network-backed voices before ever speaking. iOS exposes no
 * equivalent flag, so on iOS "offline capable" stays `unknown` until the
 * Airplane Mode test actually produces audio.
 */
export class NativeSpeechSynthesizer {
  private initialised = false;
  private voices: TtsVoice[] = [];

  async initialize(): Promise<void> {
    const status = await Tts.getInitStatus().catch((e: any) => {
      // Android reports a missing engine here rather than throwing something useful.
      throw new Error(`TTS engine unavailable: ${e?.code ?? e?.message ?? String(e)}`);
    });
    if (status !== 'success') {
      throw new Error(`TTS engine reported: ${status}`);
    }
    await Tts.setDucking(true).catch(() => undefined);
    this.voices = await Tts.voices().catch(() => []);
    this.initialised = true;
  }

  get isReady() {
    return this.initialised;
  }

  listVoices(): VoiceInfo[] {
    return this.voices.map((v) => ({
      id: v.id,
      name: v.name ?? v.id,
      language: v.language,
      networkConnectionRequired:
        typeof v.networkConnectionRequired === 'boolean' ? v.networkConnectionRequired : null,
      notInstalled: typeof v.notInstalled === 'boolean' ? v.notInstalled : null,
      quality: v.quality !== undefined ? String(v.quality) : undefined,
    }));
  }

  /**
   * Pick a voice for a language, rejecting anything Android tells us needs a
   * network or isn't actually installed. Returns null when nothing usable exists.
   */
  pickOfflineVoice(lang: Lang): TtsVoice | null {
    const prefix = lang === 'ru' ? 'ru' : 'en';
    const candidates = this.voices.filter((v) => (v.language ?? '').toLowerCase().startsWith(prefix));
    if (candidates.length === 0) return null;

    const usable = candidates.filter(
      (v) => v.networkConnectionRequired !== true && v.notInstalled !== true
    );
    const pool = usable.length > 0 ? usable : [];
    if (pool.length === 0) return null;

    // Prefer an exact locale match, then higher quality.
    const exact = pool.filter((v) => (v.language ?? '').toLowerCase() === LOCALE[lang].toLowerCase());
    const ranked = (exact.length > 0 ? exact : pool).sort(
      (a, b) => (b.quality ?? 0) - (a.quality ?? 0)
    );
    return ranked[0] ?? null;
  }

  /** Human-readable reason a language can't be spoken offline, or null if it can. */
  diagnose(lang: Lang): string | null {
    const prefix = lang === 'ru' ? 'ru' : 'en';
    const all = this.voices.filter((v) => (v.language ?? '').toLowerCase().startsWith(prefix));
    if (all.length === 0) {
      return Platform.OS === 'android'
        ? `No ${prefix} voice installed. Install voice data via Settings → System → Languages → Text-to-speech, then re-run.`
        : `No ${prefix} voice available on this device.`;
    }
    if (this.pickOfflineVoice(lang) === null) {
      return `Found ${all.length} ${prefix} voice(s), but every one requires a network connection or is not installed.`;
    }
    return null;
  }

  async speak(text: string, lang: Lang): Promise<SpeakOutcome> {
    if (!this.initialised) throw new Error('TTS is not initialised.');

    const voice = this.pickOfflineVoice(lang);
    if (!voice) {
      throw new Error(this.diagnose(lang) ?? `No usable ${lang} voice.`);
    }

    await Tts.stop().catch(() => undefined);
    await Tts.setDefaultLanguage(voice.language ?? LOCALE[lang]).catch(() => undefined);
    await Tts.setDefaultVoice(voice.id).catch(() => undefined);

    const started = Date.now();
    let firstAudioAt: number | null = null;

    return await new Promise<SpeakOutcome>((resolve, reject) => {
      const subs = [
        Tts.addEventListener('tts-start', () => {
          if (firstAudioAt === null) firstAudioAt = Date.now();
        }),
        Tts.addEventListener('tts-finish', () => {
          cleanup();
          resolve({
            firstAudioMs: (firstAudioAt ?? Date.now()) - started,
            totalMs: Date.now() - started,
            voiceId: voice.id,
            offlineCapable:
              voice.networkConnectionRequired === false
                ? true
                : voice.networkConnectionRequired === true
                ? false
                : 'unknown',
          });
        }),
        Tts.addEventListener('tts-cancel', () => {
          cleanup();
          reject(new Error('Speech was cancelled.'));
        }),
        Tts.addEventListener('tts-error', (e: any) => {
          cleanup();
          reject(new Error(`TTS error: ${e?.utteranceId ?? ''} ${JSON.stringify(e ?? {})}`));
        }),
      ];

      // A voice that needs the network typically stalls rather than erroring in
      // Airplane Mode, so a timeout is the only way that failure surfaces.
      const timeout = setTimeout(() => {
        cleanup();
        Tts.stop().catch(() => undefined);
        reject(
          new Error(
            'TTS produced no audio within 15s — the selected voice is most likely network-backed.'
          )
        );
      }, 15000);

      function cleanup() {
        clearTimeout(timeout);
        subs.forEach((s) => s.remove());
      }

      Tts.speak(text, {
        androidParams: { KEY_PARAM_STREAM: 'STREAM_MUSIC' },
        iosVoiceId: voice.id,
        rate: 0.5,
      } as any).catch((e: any) => {
        cleanup();
        reject(new Error(`speak() rejected: ${e?.message ?? String(e)}`));
      });
    });
  }

  async stop(): Promise<void> {
    await Tts.stop().catch(() => undefined);
  }

  /** Android only — opens the system flow for installing missing voice data. */
  async requestVoiceDataInstall(): Promise<boolean> {
    if (Platform.OS !== 'android' || !Tts.requestInstallData) return false;
    await Tts.requestInstallData();
    return true;
  }
}
