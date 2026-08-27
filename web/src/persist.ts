import type { NetworkProbeResult, StageTiming, TestResult, VoiceInfo } from '@core/types';

const KEY = 'ru-spike-session-v1';

export interface PersistedSession {
  results: TestResult[];
  timings: Record<string, StageTiming>;
  log: string[];
  probe: NetworkProbeResult | null;
  voices: VoiceInfo[];
  pageLoads: number;
  savedAt: string;
}

const EMPTY: PersistedSession = {
  results: [],
  timings: {},
  log: [],
  probe: null,
  voices: [],
  pageLoads: 0,
  savedAt: '',
};

/**
 * Test results survive a page reload.
 *
 * Loading a large model can push a mobile browser tab over its memory limit,
 * and the tab is then killed and reloaded with no warning and no error — every
 * result and every log line gone. That failure looked identical to "nothing
 * ran", which made it undiagnosable from the exported report.
 *
 * Persisting after each change means the evidence outlives the crash, and the
 * page-load counter turns a silent kill into a visible one.
 */
export function loadSession(): PersistedSession {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    return {
      results: Array.isArray(parsed.results) ? parsed.results : [],
      timings: parsed.timings ?? {},
      log: Array.isArray(parsed.log) ? parsed.log : [],
      probe: parsed.probe ?? null,
      voices: Array.isArray(parsed.voices) ? parsed.voices : [],
      pageLoads: typeof parsed.pageLoads === 'number' ? parsed.pageLoads : 0,
      savedAt: parsed.savedAt ?? '',
    };
  } catch {
    // Private mode, disabled storage, corrupt JSON — none of these should stop
    // the harness running, they just cost us the history.
    return { ...EMPTY };
  }
}

export function saveSession(session: Omit<PersistedSession, 'savedAt'>): void {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...session, savedAt: new Date().toISOString() } satisfies PersistedSession)
    );
  } catch {
    /* Quota or private mode. Losing history is survivable; crashing is not. */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}
