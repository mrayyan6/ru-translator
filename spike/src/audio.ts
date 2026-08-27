import { File, Paths } from 'expo-file-system';
import AudioRecord from '@fugood/react-native-audio-pcm-stream';

export const SAMPLE_RATE = 16000;
export const CHANNELS = 1 as const;
export const BITS_PER_SAMPLE = 16 as const;

/**
 * Android AudioSource.VOICE_RECOGNITION.
 *
 * This matters more than it looks. It keeps capture on the built-in microphone
 * with recognition-appropriate processing, instead of negotiating the Bluetooth
 * SCO path — which is 8 kHz narrowband and destroys Whisper's accuracy on
 * Russian. A family wearing earbuds would otherwise get bad transcripts and no
 * indication why.
 */
const AUDIO_SOURCE_VOICE_RECOGNITION = 6;

/** Hard ceiling so a stuck button can never record indefinitely. */
export const MAX_RECORDING_MS = 15000;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Uint8Array(256).fill(255);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/**
 * Hermes has no guaranteed `atob` and no Buffer, so decode base64 ourselves
 * rather than depending on a polyfill that may or may not be present.
 */
export function base64ToBytes(b64: string): Uint8Array {
  let len = b64.length;
  while (len > 0 && b64[len - 1] === '=') len--;
  const outLen = Math.floor((len * 3) / 4);
  const out = new Uint8Array(outLen);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const v = B64_LOOKUP[b64.charCodeAt(i)];
    if (v === 255) continue; // skip newlines and stray padding
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === outLen ? out : out.subarray(0, o);
}

/** Minimal 44-byte canonical WAV header for 16-bit PCM. */
export function buildWavHeader(dataBytes: number): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const byteRate = (SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;

  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) header[offset + i] = s.charCodeAt(i);
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM subchunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

export interface RecordingResult {
  /** file:// URI of a 16 kHz mono 16-bit WAV. */
  uri: string;
  durationMs: number;
  byteLength: number;
  /** True when the max-duration guard cut the recording short. */
  truncated: boolean;
}

/**
 * Push-to-talk recorder.
 *
 * We accumulate raw PCM chunks and write the WAV ourselves rather than using
 * the library's `wavFile` option. That option is undocumented in this fork and
 * whisper.rn's own adapter deliberately bypasses it, which is enough reason not
 * to trust it with the one artefact the whole pipeline depends on.
 */
export class PcmRecorder {
  private chunks: Uint8Array[] = [];
  private totalBytes = 0;
  private recording = false;
  private startedAt = 0;
  private listenerAttached = false;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private truncated = false;

  private handleChunk = (base64Chunk: string) => {
    if (!this.recording) return;
    const bytes = base64ToBytes(base64Chunk);
    this.chunks.push(bytes);
    this.totalBytes += bytes.length;
  };

  /** Safe to call repeatedly; the native side is initialised once per session. */
  init() {
    AudioRecord.init({
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      bitsPerSample: BITS_PER_SAMPLE,
      audioSource: AUDIO_SOURCE_VOICE_RECOGNITION,
      wavFile: '',
      bufferSize: 16 * 1024,
    });
    if (!this.listenerAttached) {
      AudioRecord.on('data', this.handleChunk);
      this.listenerAttached = true;
    }
  }

  start() {
    if (this.recording) return;
    this.chunks = [];
    this.totalBytes = 0;
    this.truncated = false;
    this.recording = true;
    this.startedAt = Date.now();
    AudioRecord.start();

    this.maxTimer = setTimeout(() => {
      if (this.recording) {
        this.truncated = true;
        AudioRecord.stop().catch(() => undefined);
        this.recording = false;
      }
    }, MAX_RECORDING_MS);
  }

  get isRecording() {
    return this.recording;
  }

  /** Discards the buffer without producing a file. */
  async cancel(): Promise<void> {
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
    if (this.recording) {
      this.recording = false;
      await AudioRecord.stop().catch(() => undefined);
    }
    this.chunks = [];
    this.totalBytes = 0;
  }

  async stop(filename = 'ptt.wav'): Promise<RecordingResult> {
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;

    const wasRecording = this.recording;
    this.recording = false;
    if (wasRecording) {
      await AudioRecord.stop().catch(() => undefined);
    }

    const durationMs = Date.now() - this.startedAt;
    const header = buildWavHeader(this.totalBytes);
    const wav = new Uint8Array(header.length + this.totalBytes);
    wav.set(header, 0);
    let offset = header.length;
    for (const c of this.chunks) {
      wav.set(c, offset);
      offset += c.length;
    }
    this.chunks = [];

    // Documents, never cache: on iOS the cache directory is purgeable and the
    // OS can delete its contents without warning.
    const file = new File(Paths.document, filename);
    if (file.exists) file.delete();
    file.create({ overwrite: true });
    file.write(wav);

    return {
      uri: file.uri,
      durationMs,
      byteLength: wav.length,
      truncated: this.truncated,
    };
  }
}
