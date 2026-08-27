export const TARGET_SAMPLE_RATE = 16000;
export const MAX_RECORDING_MS = 15000;

export interface WebRecordingResult {
  /** 16 kHz mono float samples, which is what Whisper wants. */
  samples: Float32Array;
  durationMs: number;
  truncated: boolean;
  /** Rate the microphone actually delivered, before resampling. */
  capturedSampleRate: number;
}

/**
 * Push-to-talk recorder for the browser.
 *
 * MediaRecorder gives us a compressed blob (webm/opus on Chrome, mp4/aac on
 * Safari), which we then decode and resample offline. Going via MediaRecorder
 * rather than an AudioWorklet costs a little latency at the end of a recording
 * but avoids shipping a worklet file and the cross-browser differences that
 * come with it — and for push-to-talk, decode happens while the user is already
 * waiting.
 */
export class WebPcmRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private startedAt = 0;
  private truncated = false;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * `start()` is async — it awaits getUserMedia and builds a MediaRecorder.
   * A quick tap releases the button before any of that finishes, and `stop()`
   * then found no recorder and threw "Not recording." Holding the pending
   * promise lets stop() wait for start() to land first.
   */
  private startPromise: Promise<void> | null = null;

  get isRecording() {
    return this.recorder?.state === 'recording';
  }

  /**
   * Requests the microphone.
   *
   * `echoCancellation` and `noiseSuppression` are left ON deliberately: they are
   * tuned for speech and help in exactly the noisy places this app gets used.
   * `autoGainControl` too — a quiet speaker at arm's length is the common case.
   */
  async requestMicrophone(): Promise<MediaStream> {
    if (this.stream) return this.stream;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'This browser will not grant microphone access. On iOS the page must be served over HTTPS.'
      );
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    return this.stream;
  }

  async start(): Promise<void> {
    this.startPromise = this.beginRecording();
    return this.startPromise;
  }

  private async beginRecording(): Promise<void> {
    const stream = await this.requestMicrophone();
    this.chunks = [];
    this.truncated = false;

    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
    this.startedAt = performance.now();

    this.maxTimer = setTimeout(() => {
      if (this.recorder?.state === 'recording') {
        this.truncated = true;
        this.recorder.stop();
      }
    }, MAX_RECORDING_MS);
  }

  async stop(): Promise<WebRecordingResult> {
    // Let a still-in-flight start() finish before deciding there is nothing to stop.
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }

    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;

    const rec = this.recorder;
    if (!rec) throw new Error('Not recording.');

    const durationMs = performance.now() - this.startedAt;
    const blob = await new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }));
      if (rec.state === 'recording') rec.stop();
      else resolve(new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' }));
    });
    this.recorder = null;

    const { samples, capturedSampleRate } = await decodeAndResample(blob);
    return { samples, durationMs, truncated: this.truncated, capturedSampleRate };
  }

  async cancel(): Promise<void> {
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.maxTimer = null;
    if (this.recorder?.state === 'recording') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.recorder = null;
    this.chunks = [];
  }

  /** Releases the microphone so the browser stops showing the recording indicator. */
  release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

function pickMimeType(): string | null {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(c)) return c;
  }
  return null; // let the browser choose — Safari historically ignores the hint anyway
}

/** Below this, MediaRecorder has not produced a container it can decode. */
const MIN_DECODABLE_BYTES = 2048;

async function decodeAndResample(
  blob: Blob
): Promise<{ samples: Float32Array; capturedSampleRate: number }> {
  const arrayBuffer = await blob.arrayBuffer();

  // A very short press produces a blob with a container header and almost no
  // audio, which `decodeAudioData` rejects with the unhelpful "Unable to decode
  // audio data". Catching it here turns that into something a person can act on.
  if (arrayBuffer.byteLength < MIN_DECODABLE_BYTES) {
    throw new Error(
      `That press was too short to capture anything (${arrayBuffer.byteLength} bytes). ` +
        'Hold the button down while you speak, then release.'
    );
  }

  const Ctor: typeof AudioContext =
    (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
  const decodeCtx = new Ctor();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
  } catch (e: any) {
    throw new Error(
      `Could not decode the recording (${blob.type || 'unknown type'}, ` +
        `${arrayBuffer.byteLength} bytes): ${e?.message ?? e}`
    );
  } finally {
    await decodeCtx.close().catch(() => undefined);
  }

  const capturedSampleRate = decoded.sampleRate;
  if (capturedSampleRate === TARGET_SAMPLE_RATE && decoded.numberOfChannels === 1) {
    return { samples: decoded.getChannelData(0).slice(), capturedSampleRate };
  }

  const frames = Math.max(
    1,
    Math.ceil((decoded.duration * TARGET_SAMPLE_RATE))
  );
  const OfflineCtor: typeof OfflineAudioContext =
    (globalThis as any).OfflineAudioContext ?? (globalThis as any).webkitOfflineAudioContext;
  const offline = new OfflineCtor(1, frames, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return { samples: rendered.getChannelData(0).slice(), capturedSampleRate };
}

/** Rough loudness check, used to catch a dead or muted microphone early. */
export function peakAmplitude(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}
