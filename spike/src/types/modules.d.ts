/**
 * Hand-written declarations for packages that ship no usable types.
 *
 * `@fugood/react-native-audio-pcm-stream` ships a .d.ts, but it declares the
 * module under its old name (`react-native-live-audio-stream`), so it never
 * applies to the import path we actually use.
 */

declare module '@fugood/react-native-audio-pcm-stream' {
  export interface PcmOptions {
    sampleRate: number;
    /** 1 = mono, 2 = stereo. */
    channels: 1 | 2;
    bitsPerSample: 8 | 16;
    /**
     * Android MediaRecorder.AudioSource. 6 = VOICE_RECOGNITION, which keeps
     * capture on the built-in mic and avoids the 8 kHz Bluetooth SCO path.
     */
    audioSource?: number;
    /** Empty string means "don't write a file, just stream chunks to us". */
    wavFile: string;
    bufferSize?: number;
  }

  export interface AudioRecordStatic {
    init(options: PcmOptions): void;
    start(): void;
    stop(): Promise<string>;
    /** Chunks arrive as base64-encoded little-endian signed 16-bit PCM. */
    on(event: 'data', callback: (base64Chunk: string) => void): void;
  }

  const AudioRecord: AudioRecordStatic;
  export default AudioRecord;
}

declare module 'react-native-tts' {
  export interface TtsVoice {
    id: string;
    name: string;
    language: string;
    quality?: number;
    latency?: number;
    /** Android only. Undefined on iOS, which exposes no equivalent flag. */
    networkConnectionRequired?: boolean;
    /** Android only. */
    notInstalled?: boolean;
  }

  export interface TtsSubscription {
    remove(): void;
  }

  const Tts: {
    getInitStatus(): Promise<'success' | string>;
    voices(): Promise<TtsVoice[]>;
    setDefaultLanguage(lang: string): Promise<'success' | string>;
    setDefaultVoice(voiceId: string): Promise<'success' | string>;
    setDefaultRate(rate: number, skipTransform?: boolean): Promise<void>;
    setDucking(enabled: boolean): Promise<void>;
    speak(text: string, options?: Record<string, unknown>): Promise<string>;
    stop(onWordBoundary?: boolean): Promise<boolean>;
    addEventListener(
      type: 'tts-start' | 'tts-progress' | 'tts-finish' | 'tts-cancel' | 'tts-error',
      handler: (event: any) => void
    ): TtsSubscription;
    /** Android only. Returns LANG_MISSING_DATA etc. Not present on iOS. */
    engines?(): Promise<{ name: string; label: string; default: boolean }[]>;
    requestInstallData?(): Promise<void>;
  };

  export default Tts;
}
