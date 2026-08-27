export type Lang = 'en' | 'ru';

export type TestStatus =
  | 'PASS'
  | 'FAIL'
  | 'SKIP'
  | 'INVALID'; // ran, but the network was reachable so an "offline" claim is not trustworthy

/** One row of the Phase 0 evidence table. */
export interface TestResult {
  id: string;
  label: string;
  status: TestStatus;
  /** Wall-clock duration of the measured stage, milliseconds. */
  ms?: number;
  /** Whether the network was verified unreachable at the moment this ran. */
  offlineVerified: boolean;
  detail?: string;
  error?: string;
  at: string; // ISO timestamp
}

export interface DeviceInfo {
  platform: 'android' | 'ios' | 'other';
  osVersion: string;
  modelName: string;
  brand: string | null;
  /** Total RAM in bytes, or null if the OS won't say. */
  totalMemoryBytes: number | null;
  supportedCpuArchitectures: string[] | null;
  freeStorageBytes: number | null;
  totalStorageBytes: number | null;
  isDevice: boolean;
  appVersion: string;
}

export type WhisperVariant = 'tiny' | 'base' | 'small';

export interface SttOutcome {
  text: string;
  /** Mean log-probability reported by whisper.cpp, if exposed. Higher is better. */
  avgLogprob: number | null;
  /** Probability the clip contained no speech, if exposed. Lower is better. */
  noSpeechProb: number | null;
  /** True when our guards judged the transcript untrustworthy. */
  rejected: boolean;
  rejectReason?: string;
  /** Milliseconds spent inside transcription only. */
  transcribeMs: number;
  /** Backend that actually ran, e.g. "coreml" or "cpu" — whisper.cpp can fall back silently. */
  backend?: string;
}

export interface StageTiming {
  recordMs?: number;
  vadMs?: number;
  sttMs?: number;
  translateMs?: number;
  backTranslateMs?: number;
  ttsFirstAudioMs?: number;
  totalMs?: number;
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  /** Android exposes this directly. iOS does not — null means "unknown, must be proven by testing". */
  networkConnectionRequired: boolean | null;
  notInstalled: boolean | null;
  quality?: string;
}

export interface Phase0Report {
  generatedAt: string;
  device: DeviceInfo;
  whisperVariant: WhisperVariant;
  /**
   * Null when the probe was never run. Previously this defaulted to a
   * zero-value object, which rendered as "network was reachable" — a default
   * presented as a measurement, and the most misleading thing a report can do.
   */
  networkProbe: NetworkProbeResult | null;
  results: TestResult[];
  timings: Record<string, StageTiming>;
  voices: VoiceInfo[];
  notes: string[];
  /**
   * The on-screen event log, newest first.
   *
   * Included because the errors that actually explain a failed run only ever
   * appeared here, and were therefore never in the artefact anyone sent on.
   * A report that omits the error message is not a report.
   */
  log: string[];
  /** How many times the page loaded for this stored session — a tab crash increments it. */
  pageLoads?: number;
}

export interface NetworkProbeResult {
  /**
   * True only when every probe failed AND the browser also reports no
   * connection. Deliberately strict: a false "offline" would promote every
   * INVALID result to PASS.
   */
  offline: boolean;
  /** Probes all failed but the browser still claims a connection — unproven, not offline. */
  inconclusive: boolean;
  navigatorOnLine: boolean;
  checkedAt: string;
  /** What each probe target did. */
  attempts: { target: string; reachable: boolean; ms: number; error?: string }[];
}
