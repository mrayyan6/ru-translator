import type { Phase0Report, StageTiming, TestResult, TestStatus } from './types';

/** The ten rows of the acceptance table, in the order they were specified. */
export const ACCEPTANCE_ROWS: { id: string; label: string }[] = [
  // Not "small" — the variant under test is recorded in the device table, and
  // hardcoding it here mislabelled every run that used base.
  { id: 'whisper-load', label: 'Speech model loads' },
  { id: 'stt-en-offline', label: 'English STT offline' },
  { id: 'stt-ru-offline', label: 'Russian STT offline' },
  { id: 'mt-en-ru-offline', label: 'ML Kit EN→RU offline' },
  { id: 'mt-ru-en-offline', label: 'ML Kit RU→EN offline' },
  { id: 'tts-en-offline', label: 'English TTS offline' },
  { id: 'tts-ru-offline', label: 'Russian TTS offline' },
  { id: 'pipeline-en-ru', label: 'Complete EN→RU pipeline' },
  { id: 'pipeline-ru-en', label: 'Complete RU→EN pipeline' },
  { id: 'cold-start-airplane', label: 'Airplane Mode cold start' },
];

function bytesToGb(b: number | null): string {
  if (b === null) return 'unknown';
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function ms(v: number | undefined): string {
  return v === undefined ? '—' : `${Math.round(v)} ms`;
}

function statusCell(r: TestResult | undefined): string {
  if (!r) return '—';
  if (r.status === 'INVALID') return 'INVALID';
  return r.status;
}

export function summarise(results: TestResult[]) {
  const byStatus = (s: TestStatus) => results.filter((r) => r.status === s).length;
  return {
    pass: byStatus('PASS'),
    fail: byStatus('FAIL'),
    skip: byStatus('SKIP'),
    invalid: byStatus('INVALID'),
    total: results.length,
  };
}

export function toMarkdown(report: Phase0Report): string {
  const d = report.device;
  const byId = new Map(report.results.map((r) => [r.id, r]));
  const platformLabel = d.platform === 'ios' ? 'iOS' : d.platform === 'android' ? 'Android' : d.platform;
  const s = summarise(report.results);

  const lines: string[] = [];

  lines.push(`# Phase 0 spike report — ${platformLabel}`);
  lines.push('');
  lines.push(`Generated ${report.generatedAt}`);
  lines.push('');

  if (report.networkProbe === null) {
    lines.push('> **The network probe was never run, so nothing below is trustworthy.**');
    lines.push('> Press "Run network probe" first — without it there is no evidence either way.');
    lines.push('');
  } else if (!report.networkProbe.offline) {
    lines.push('> **WARNING — the network was reachable when these tests ran.**');
    lines.push('> Every offline claim below is stamped INVALID. Enable Airplane Mode and re-run.');
    lines.push('');
  }

  if (report.results.length === 0) {
    lines.push('> **No test recorded a result.** Either nothing was run, or the page reloaded and');
    lines.push('> lost its state mid-run. Check the log at the end of this report.');
    lines.push('');
  }

  lines.push('## Device');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Model | ${d.brand ? d.brand + ' ' : ''}${d.modelName} |`);
  lines.push(`| OS | ${platformLabel} ${d.osVersion} |`);
  lines.push(`| RAM | ${bytesToGb(d.totalMemoryBytes)} |`);
  lines.push(`| CPU / arch | ${d.supportedCpuArchitectures?.join(', ') ?? 'unknown'} |`);
  lines.push(`| Storage free | ${bytesToGb(d.freeStorageBytes)} of ${bytesToGb(d.totalStorageBytes)} |`);
  lines.push(`| Physical device | ${d.isDevice ? 'yes' : 'NO — simulator, results not valid'} |`);
  lines.push(`| Whisper variant | ${report.whisperVariant} |`);
  lines.push(`| App version | ${d.appVersion} |`);
  lines.push('');

  lines.push('## Network probe');
  lines.push('');
  if (report.networkProbe === null) {
    lines.push('**NOT RUN.** No measurement was taken, so the offline state is unknown.');
    lines.push('');
  } else {
    lines.push(
      report.networkProbe.offline
        ? '**Offline confirmed.** No probe was reachable and the browser reports no connection, so offline results are trustworthy.'
        : report.networkProbe.inconclusive
        ? '**Inconclusive.** Every probe failed, but the browser still reports a connection — most likely the requests were blocked rather than the network being down. Not treated as offline.'
        : '**Network was reachable.** Offline results are not trustworthy.'
    );
    lines.push('');
    lines.push(`Checked at ${report.networkProbe.checkedAt}`);
    lines.push('');
    lines.push(`\`navigator.onLine\`: ${report.networkProbe.navigatorOnLine}`);
    lines.push('');
    lines.push('| Target | Reachable | Time | Error |');
    lines.push('| --- | --- | --- | --- |');
    for (const a of report.networkProbe.attempts) {
      lines.push(`| ${a.target} | ${a.reachable ? 'YES' : 'no'} | ${ms(a.ms)} | ${a.error ?? '—'} |`);
    }
    lines.push('');
  }

  lines.push('## Acceptance criteria');
  lines.push('');
  lines.push(`| Test | ${platformLabel} | Latency | Detail |`);
  lines.push('| --- | --- | --- | --- |');
  for (const row of ACCEPTANCE_ROWS) {
    const r = byId.get(row.id);
    lines.push(
      `| ${row.label} | ${statusCell(r)} | ${ms(r?.ms)} | ${(r?.detail ?? r?.error ?? '—').replace(/\|/g, '\\|')} |`
    );
  }
  lines.push('');
  lines.push(`Summary: ${s.pass} pass, ${s.fail} fail, ${s.invalid} invalid, ${s.skip} skipped.`);
  lines.push('');

  const timingKeys = Object.keys(report.timings);
  if (timingKeys.length > 0) {
    lines.push('## Stage latency');
    lines.push('');
    lines.push('| Run | Record | VAD | STT | Translate | Back-translate | TTS first audio | Total |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const k of timingKeys) {
      const t: StageTiming = report.timings[k];
      lines.push(
        `| ${k} | ${ms(t.recordMs)} | ${ms(t.vadMs)} | ${ms(t.sttMs)} | ${ms(t.translateMs)} | ${ms(
          t.backTranslateMs
        )} | ${ms(t.ttsFirstAudioMs)} | ${ms(t.totalMs)} |`
      );
    }
    lines.push('');
  }

  if (report.voices.length > 0) {
    lines.push('## TTS voices found');
    lines.push('');
    lines.push('| Voice | Language | Network required | Not installed | Usable offline |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const v of report.voices) {
      const usable =
        v.networkConnectionRequired === true || v.notInstalled === true
          ? 'NO'
          : v.networkConnectionRequired === null
          ? 'unknown — prove by test'
          : 'yes';
      lines.push(
        `| ${v.name || v.id} | ${v.language} | ${v.networkConnectionRequired ?? 'n/a'} | ${
          v.notInstalled ?? 'n/a'
        } | ${usable} |`
      );
    }
    lines.push('');
  }

  const detailed = report.results.filter((r) => !ACCEPTANCE_ROWS.some((a) => a.id === r.id));
  if (detailed.length > 0) {
    lines.push('## Per-utterance results');
    lines.push('');
    lines.push('| Test | Status | Latency | Detail |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of detailed) {
      lines.push(
        `| ${r.label} | ${statusCell(r)} | ${ms(r.ms)} | ${(r.detail ?? r.error ?? '—').replace(/\|/g, '\\|')} |`
      );
    }
    lines.push('');
  }

  if (report.notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const n of report.notes) lines.push(`- ${n}`);
    lines.push('');
  }

  // Last, and never omitted: this is where the actual error messages live, and
  // a run that "just didn't work" is only diagnosable from here.
  lines.push('## Event log');
  lines.push('');
  if (report.pageLoads !== undefined && report.pageLoads > 1) {
    lines.push(
      `**The page loaded ${report.pageLoads} times for this stored session.** A reload mid-run ` +
        'usually means the tab was killed — on mobile, most often for memory. The log below is ' +
        'restored from storage and should show what was happening immediately before.'
    );
    lines.push('');
  }
  if (report.log.length === 0) {
    lines.push('_Empty._');
  } else {
    lines.push('```');
    // Oldest first reads better than the on-screen order when reconstructing a failure.
    for (const line of [...report.log].reverse()) lines.push(line);
    lines.push('```');
  }
  lines.push('');

  return lines.join('\n');
}

export function toJson(report: Phase0Report): string {
  return JSON.stringify(report, null, 2);
}
