import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EN_UTTERANCES, RU_UTTERANCES, TTS_PROBES, type Utterance } from '@core/corpus';
import { getJsRequestCount, probeNetworkUncounted } from '@core/netprobe';
import { summarise, toMarkdown } from '@core/report';
import type {
  Lang,
  NetworkProbeResult,
  Phase0Report,
  StageTiming,
  TestResult,
  TestStatus,
  VoiceInfo,
  WhisperVariant,
} from '@core/types';

import { collectWebDeviceInfo, type WebDeviceInfo } from './device';
import { mt, recorder, tts, webSpeech, whisper } from './engines/singletons';
import { cachedBytes, clearModelCache } from './modelCache';
import { clearSession, loadSession, saveSession } from './persist';
import { getSttDevice, getSttVariant, setSttDevice, setSttVariant } from './settings';
import type { SttDevice } from './engines/stt';
import { forceUpdate } from './updateApp';
import { formatBytes, getStorageStatus, requestPersistentStorage, type StorageStatus } from './storage';
import { detectWebGpu, setOfflineMode, transformersDiagnostics } from './transformersEnv';

const APP_VERSION = 'web-spike-0.1.0';

/** Read once per page load, so a tab that was killed comes back with its evidence. */
const restored = loadSession();

type SttEngineChoice = 'auto' | 'whisper' | 'platform';

export default function App() {
  const [device, setDevice] = useState<WebDeviceInfo | null>(null);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [probe, setProbe] = useState<NetworkProbeResult | null>(restored.probe);
  const [pageLoads] = useState(() => restored.pageLoads + 1);
  const [variant, setVariant] = useState<WhisperVariant>(getSttVariant);
  // Named apart from `device` above, which holds the *device info* for the report.
  const [sttDevice, setSttDeviceState] = useState<SttDevice>(getSttDevice);
  const [sttChoice, setSttChoice] = useState<SttEngineChoice>('auto');
  const [gpu, setGpu] = useState<{ available: boolean; reason: string } | null>(null);
  const [platformStt, setPlatformStt] = useState<{ available: boolean; reason: string } | null>(null);

  const [results, setResults] = useState<TestResult[]>(restored.results);
  const [timings, setTimings] = useState<Record<string, StageTiming>>(restored.timings);
  const [voices, setVoices] = useState<VoiceInfo[]>(restored.voices);
  const [log, setLog] = useState<string[]>(restored.log);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');
  const [recording, setRecording] = useState(false);

  const [utterance, setUtterance] = useState<Utterance>(EN_UTTERANCES[0]);
  const [transcript, setTranscript] = useState('');
  const [translation, setTranslation] = useState('');
  const [backTranslation, setBackTranslation] = useState('');
  const [cacheSize, setCacheSize] = useState<number>(0);

  const lastSamples = useRef<Float32Array | null>(null);
  const recordingRef = useRef(false);
  const offlineVerified = probe?.offline ?? false;

  const say = useCallback((line: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 200));
  }, []);

  const refreshEnvironment = useCallback(async () => {
    setDevice(await collectWebDeviceInfo(APP_VERSION));
    setStorage(await getStorageStatus());
    setCacheSize(await cachedBytes());
  }, []);

  // Persist after every meaningful change, so a tab kill cannot take the
  // evidence with it.
  useEffect(() => {
    saveSession({ results, timings, log, probe, voices, pageLoads });
  }, [results, timings, log, probe, voices, pageLoads]);

  useEffect(() => {
    (async () => {
      if (pageLoads > 1) {
        say(
          `Page load #${pageLoads} for this session — restored ${restored.results.length} result(s). ` +
            'If you did not reload deliberately, the tab was killed, most likely for memory.'
        );
      }
      await refreshEnvironment();
      setGpu(await detectWebGpu());
      setPlatformStt(await webSpeech.isAvailable('ru'));

      // Probe automatically. Leaving it to be pressed meant a whole run could
      // complete with no evidence of the network state at all, and the report
      // then showed a default value that read like a measurement.
      const p = await probeNetworkUncounted();
      setProbe(p);
      say(
        p.offline
          ? 'Startup probe: OFFLINE confirmed.'
          : p.inconclusive
          ? 'Startup probe: INCONCLUSIVE — probes failed but the browser reports a connection.'
          : 'Startup probe: network reachable.'
      );
    })().catch((e) => say(`startup: ${e?.message ?? e}`));
  }, [refreshEnvironment, say, pageLoads]);

  const record = useCallback(
    (id: string, label: string, status: TestStatus, ms?: number, detail?: string, error?: string) => {
      const needsOffline =
        id.includes('offline') || id.startsWith('pipeline') || id.includes('cold-start');
      const finalStatus: TestStatus =
        status === 'PASS' && needsOffline && !offlineVerified ? 'INVALID' : status;
      setResults((prev) => [
        ...prev.filter((r) => r.id !== id),
        { id, label, status: finalStatus, ms, offlineVerified, detail, error, at: new Date().toISOString() },
      ]);
      say(`${finalStatus}  ${label}${ms !== undefined ? ` (${Math.round(ms)}ms)` : ''}`);
    },
    [offlineVerified, say]
  );

  const guard = useCallback(
    async (name: string, fn: () => Promise<void>) => {
      if (busy) return;
      setBusy(name);
      try {
        await fn();
      } catch (e: any) {
        say(`ERROR in ${name}: ${e?.message ?? String(e)}`);
      } finally {
        setBusy(null);
        setProgress('');
      }
    },
    [busy, say]
  );

  /* ------------------------------------------------------------------ steps */

  const runProbe = () =>
    guard('Network probe', async () => {
      const p = await probeNetworkUncounted();
      setProbe(p);
      say(
        p.offline
          ? 'Offline confirmed — no probe reachable and the browser reports no connection.'
          : p.inconclusive
          ? 'INCONCLUSIVE — probes failed but the browser still reports a connection. Not treating this as offline.'
          : 'NETWORK REACHABLE — offline results will be marked INVALID.'
      );
    });

  const enablePersistence = () =>
    guard('Request persistent storage', async () => {
      const granted = await requestPersistentStorage();
      await refreshEnvironment();
      say(
        granted
          ? 'Persistent storage GRANTED — models are exempt from automatic eviction.'
          : 'Persistent storage DENIED. Install to the home screen first, then try again; without this the browser may delete the models after ~7 days unused.'
      );
    });

  const downloadModels = () =>
    guard('Download models', async () => {
      setOfflineMode(false);
      say('Downloading translation models…');
      for (const [from, to] of [
        ['en', 'ru'],
        ['ru', 'en'],
      ] as [Lang, Lang][]) {
        // Resolve the id BEFORE the call. Referencing a destructured binding
        // from inside the progress callback is a temporal dead zone: the
        // callback fires during the download, while the binding is still
        // uninitialised, which throws "Cannot access 'modelId' before
        // initialization" on the very first progress event.
        const modelId = mt.modelIdFor(from, to);
        const { ms, dtype } = await mt.load(
          from,
          to,
          (p) => setProgress(`${modelId} ${Math.round(p.progress)}%`),
          say
        );
        say(`  ${modelId} ready in ${Math.round(ms)}ms (${dtype})`);
      }

      say(`Downloading Whisper ${variant}…`);
      const device = getSttDevice();
      const load = await whisper.load(
        variant,
        device,
        (p) => setProgress(`whisper ${Math.round(p.progress)}%`),
        say
      );
      say(`  ${load.modelId} ready in ${Math.round(load.ms)}ms on ${load.device} (${load.dtype})`);

      await refreshEnvironment();
      say(`Model cache now holds ${formatBytes(await cachedBytes())}.`);
    });

  const armOffline = () =>
    guard('Arm offline mode', async () => {
      setOfflineMode(true);
      say('Offline mode armed — remote model loading is now disabled at the library level.');
    });

  const loadWhisper = () =>
    guard('Load Whisper', async () => {
      const dev = getSttDevice();
      const load = await whisper.load(
        variant,
        dev,
        (p) => setProgress(`whisper ${Math.round(p.progress)}%`),
        say
      );
      const diag = transformersDiagnostics();

      // Pay the shader/kernel compilation cost now and time it separately, so a
      // slow first utterance can be told apart from a slow model.
      setProgress('warming up…');
      const warmMs = await whisper.warmUp('en');
      say(`Warm-up inference: ${Math.round(warmMs)}ms`);

      record(
        'whisper-load',
        `Whisper ${variant} loads`,
        'PASS',
        load.ms,
        `device=${load.device}, dtype=${load.dtype}, warmUp=${Math.round(warmMs)}ms, ` +
          `wasmThreads=${diag.wasmThreads}, crossOriginIsolated=${diag.crossOriginIsolated}, ` +
          `attempts=[${load.attempts.join('; ')}]`
      );
      if (!diag.crossOriginIsolated) {
        say(
          'WARNING: not cross-origin isolated, so WASM is single-threaded and several times slower. Check the COOP/COEP headers.'
        );
      }
    });

  /**
   * Push-to-talk deliberately bypasses `guard`.
   *
   * `guard` refuses to run while something else is busy, which is right for the
   * numbered test steps and badly wrong here: a quick tap could land the stop
   * while start was still marked busy, so the stop was dropped and the recorder
   * ran until the 15-second cap with no way to interrupt it.
   *
   * A ref rather than the `recording` state because pointerup and pointerleave
   * can both fire for one gesture, and React state has not updated between them.
   */
  /**
   * Three inferences on the same one-second clip.
   *
   * The first pays for shader and kernel compilation; the rest are steady
   * state. Reporting them separately is the only way to tell "slow once" from
   * "slow always", which decides whether the answer is a warm-up or a
   * different model entirely.
   */
  const benchmarkStt = () =>
    guard('Benchmark speech', async () => {
      if (whisper.loadedVariant === null) throw new Error('Load the speech model first.');
      const runs: number[] = [];
      for (let i = 0; i < 3; i++) {
        setProgress(`run ${i + 1} of 3`);
        const ms = await whisper.warmUp('en');
        runs.push(ms);
        say(`  run ${i + 1}: ${Math.round(ms)}ms`);
      }
      const steady = runs.slice(1);
      const avg = steady.reduce((a, b) => a + b, 0) / steady.length;
      record(
        'stt-benchmark',
        'Speech benchmark (1s clip x3)',
        'PASS',
        avg,
        `first=${Math.round(runs[0])}ms incl. compilation, steady=${steady
          .map((m) => Math.round(m))
          .join(' / ')}ms, device=${whisper.activeDevice}, dtype=${whisper.activeDtype}`
      );
    });

  const startRecording = useCallback(async () => {
    if (recordingRef.current) return;
    recordingRef.current = true;
    setTranscript('');
    setTranslation('');
    setBackTranslation('');
    try {
      await recorder.start();
      setRecording(true);
    } catch (e: any) {
      recordingRef.current = false;
      setRecording(false);
      say(`ERROR starting recording: ${e?.message ?? e}`);
    }
  }, [say]);

  const stopRecordingAndTranscribe = useCallback(async () => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    setBusy('Transcribe');
    try {
      const rec = await recorder.stop();
      lastSamples.current = rec.samples;
      say(
        `Recorded ${Math.round(rec.durationMs)}ms, captured at ${rec.capturedSampleRate}Hz${
          rec.truncated ? ' (TRUNCATED)' : ''
        }`
      );

      const usePlatform =
        sttChoice === 'platform' || (sttChoice === 'auto' && platformStt?.available === true);
      const res = usePlatform
        ? await webSpeech.listen(utterance.lang)
        : await whisper.transcribe(rec.samples, utterance.lang);

      setTranscript(res.outcome.rejected ? `[rejected: ${res.outcome.rejectReason}]` : res.outcome.text);

      const id = utterance.lang === 'en' ? 'stt-en-offline' : 'stt-ru-offline';
      record(
        id,
        utterance.lang === 'en' ? 'English STT offline' : 'Russian STT offline',
        res.outcome.rejected ? 'FAIL' : 'PASS',
        res.sttMs,
        res.outcome.rejected
          ? res.outcome.rejectReason
          : `heard "${res.outcome.text}" | expected "${utterance.say}" | engine=${res.engine}`
      );
      record(
        `utt-${utterance.id}`,
        `${utterance.id}: ${utterance.say}`,
        res.outcome.rejected ? 'FAIL' : 'PASS',
        res.sttMs,
        res.outcome.rejected ? res.outcome.rejectReason : res.outcome.text
      );
      setTimings((t) => ({
        ...t,
        [utterance.id]: { recordMs: rec.durationMs, sttMs: res.sttMs },
      }));
    } catch (e: any) {
      say(`ERROR in Transcribe: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [record, say, sttChoice, platformStt, utterance]);

  const cancelRecording = useCallback(async () => {
    recordingRef.current = false;
    setRecording(false);
    await recorder.cancel();
    say('Recording cancelled.');
  }, [say]);

  const testTranslate = (from: Lang, to: Lang) =>
    guard(`Translate ${from}→${to}`, async () => {
      const source = from === 'en' ? EN_UTTERANCES[0].say : RU_UTTERANCES[0].say;
      if (!mt.isLoaded(from, to)) await mt.load(from, to);
      if (!mt.isLoaded(to, from)) await mt.load(to, from);
      const rt = await mt.roundTrip(source, from, to);
      setTranslation(rt.forward);
      setBackTranslation(rt.back);
      record(
        from === 'en' ? 'mt-en-ru-offline' : 'mt-ru-en-offline',
        from === 'en' ? 'EN→RU translation offline' : 'RU→EN translation offline',
        'PASS',
        rt.forwardMs,
        `"${source}" → "${rt.forward}" | round-trip: "${rt.back}"`
      );
      setTimings((t) => ({
        ...t,
        [`mt-${from}-${to}`]: { translateMs: rt.forwardMs, backTranslateMs: rt.backMs },
      }));
    });

  const loadVoices = () =>
    guard('Inspect voices', async () => {
      await tts.initialize();
      const list = tts.listVoices();
      setVoices(list);
      const local = list.filter((v) => v.networkConnectionRequired === false);
      say(`${list.length} voices, ${local.length} local (offline-capable).`);
      for (const lang of ['en', 'ru'] as Lang[]) {
        const problem = tts.diagnose(lang);
        if (problem) say(`${lang.toUpperCase()}: ${problem}`);
      }
    });

  const testTts = (lang: Lang) =>
    guard(`Speak ${lang}`, async () => {
      if (voices.length === 0) await tts.initialize();
      const out = await tts.speak(TTS_PROBES[lang], lang);
      record(
        lang === 'en' ? 'tts-en-offline' : 'tts-ru-offline',
        lang === 'en' ? 'English TTS offline' : 'Russian TTS offline',
        'PASS',
        out.firstAudioMs,
        `voice="${out.voiceName}", localService=${out.localService}, total=${Math.round(out.totalMs)}ms`
      );
    });

  const runPipeline = (from: Lang) =>
    guard(`Pipeline ${from}`, async () => {
      const to: Lang = from === 'en' ? 'ru' : 'en';
      const samples = lastSamples.current;
      if (!samples) throw new Error('Record an utterance first — the pipeline reuses the last one.');

      const t0 = performance.now();
      // Use whichever engine the STT step is actually configured to use.
      // Running the pipeline test against Whisper while the STT step used the
      // platform recogniser would measure a path the app never takes.
      const usePlatform =
        sttChoice === 'platform' || (sttChoice === 'auto' && platformStt?.available === true);
      const res = usePlatform
        ? await webSpeech.listen(from)
        : await whisper.transcribe(samples, from);
      if (res.outcome.rejected) {
        record(
          from === 'en' ? 'pipeline-en-ru' : 'pipeline-ru-en',
          from === 'en' ? 'Complete EN→RU pipeline' : 'Complete RU→EN pipeline',
          'FAIL',
          performance.now() - t0,
          undefined,
          `STT rejected: ${res.outcome.rejectReason}`
        );
        return;
      }
      setTranscript(res.outcome.text);

      if (!mt.isLoaded(from, to)) await mt.load(from, to);
      const translated = await mt.translate(res.outcome.text, from, to);
      setTranslation(translated.text);

      if (voices.length === 0) await tts.initialize();
      const spoken = await tts.speak(translated.text, to);
      const totalMs = performance.now() - t0;

      record(
        from === 'en' ? 'pipeline-en-ru' : 'pipeline-ru-en',
        from === 'en' ? 'Complete EN→RU pipeline' : 'Complete RU→EN pipeline',
        'PASS',
        totalMs,
        `"${res.outcome.text}" → "${translated.text}" (stt ${Math.round(res.sttMs)}ms, mt ${Math.round(
          translated.ms
        )}ms, tts ${Math.round(spoken.firstAudioMs)}ms)`
      );
      setTimings((t) => ({
        ...t,
        [`pipeline-${from}`]: {
          sttMs: res.sttMs,
          translateMs: translated.ms,
          ttsFirstAudioMs: spoken.firstAudioMs,
          totalMs,
        },
      }));
    });

  const buildReport = useCallback((): Phase0Report | null => {
    if (!device) return null;
    const diag = transformersDiagnostics();
    return {
      generatedAt: new Date().toISOString(),
      device,
      whisperVariant: variant,
      // Null when never run. Never substitute a default here — a zero-value
      // probe renders as "network was reachable", which reads like evidence.
      networkProbe: probe,
      results,
      timings,
      voices,
      log,
      pageLoads,
      notes: [
        `Build: PWA (${device.browser}), ${device.standalone ? 'installed to home screen' : 'running in a browser tab'}`,
        `Cross-origin isolated: ${diag.crossOriginIsolated} — WASM threads: ${diag.wasmThreads}`,
        `WebGPU: ${gpu?.available ? 'available' : `unavailable (${gpu?.reason ?? 'not checked'})`}`,
        `Platform on-device STT: ${platformStt?.available ? 'available' : `unavailable (${platformStt?.reason ?? 'not checked'})`}`,
        `Persistent storage: ${storage?.persisted ? 'granted' : 'NOT granted — models may be evicted after ~7 days unused'}`,
        `Model cache: ${formatBytes(cacheSize)} in IndexedDB; origin quota ${formatBytes(storage?.quotaBytes ?? null)}`,
        `JS-layer outbound requests since load: ${getJsRequestCount()}`,
        'Peak memory is not measurable from a browser; the tab simply reloads if it is exceeded.',
      ],
    };
  }, [
    device,
    variant,
    probe,
    results,
    timings,
    voices,
    gpu,
    platformStt,
    storage,
    cacheSize,
    log,
    pageLoads,
  ]);

  const copyReport = () =>
    guard('Copy report', async () => {
      const report = buildReport();
      if (!report) throw new Error('Device info not ready.');
      const md = toMarkdown(report);
      await navigator.clipboard.writeText(md);
      say('Report copied to clipboard.');
    });

  const shareReport = () =>
    guard('Share report', async () => {
      const report = buildReport();
      if (!report) throw new Error('Device info not ready.');
      const md = toMarkdown(report);
      if (navigator.share) {
        await navigator.share({ title: 'Phase 0 web spike report', text: md });
        say('Shared.');
      } else {
        const blob = new Blob([md], { type: 'text/markdown' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `phase0-web-${Date.now()}.md`;
        a.click();
        URL.revokeObjectURL(a.href);
        say('Downloaded.');
      }
    });

  const wipeModels = () =>
    guard('Delete models', async () => {
      await clearModelCache();
      await refreshEnvironment();
      say('Model cache cleared.');
    });

  const summary = useMemo(() => summarise(results), [results]);
  const utteranceList = utterance.lang === 'en' ? EN_UTTERANCES : RU_UTTERANCES;

  return (
    <main>
      <h1>Phase 0 · web spike</h1>

      <div className={`banner ${offlineVerified ? 'ok' : 'warn'}`}>
        {probe === null
          ? 'Network state unknown — run the probe before trusting any result.'
          : offlineVerified
          ? 'OFFLINE CONFIRMED — results are trustworthy'
          : probe.inconclusive
          ? 'INCONCLUSIVE — probes failed but the browser still reports a connection'
          : 'NETWORK REACHABLE — offline results will be marked INVALID'}
      </div>

      {busy && <div className="busy">{busy}… {progress}</div>}

      <section>
        <h2>Environment</h2>
        {device && (
          <>
            <code>{device.browser} · {device.platform} {device.osVersion}</code>
            <code>cores: {device.hardwareConcurrency ?? '?'} · deviceMemory: {device.deviceMemoryGb ?? 'not exposed'} GB</code>
            <code>installed to home screen: {device.standalone ? 'yes' : 'NO — install for better storage'}</code>
            <code>cross-origin isolated: {device.crossOriginIsolated ? 'yes' : 'NO — WASM will be single-threaded'}</code>
          </>
        )}
        {gpu && <code>WebGPU: {gpu.available ? 'available' : `unavailable — ${gpu.reason}`}</code>}
        {platformStt && (
          <code>platform on-device STT: {platformStt.available ? 'available' : `unavailable — ${platformStt.reason}`}</code>
        )}
        {storage && (
          <code>
            storage: {formatBytes(storage.usageBytes)} used of {formatBytes(storage.quotaBytes)} · persisted:{' '}
            {storage.persisted ? 'yes' : 'NO'}
          </code>
        )}
      </section>

      <section>
        <h2>1 · Network probe</h2>
        <button onClick={runProbe} disabled={!!busy}>Run network probe</button>
        {probe?.attempts.map((a) => (
          <code key={a.target}>
            {a.target}: {a.reachable ? 'REACHABLE' : 'unreachable'} ({a.ms}ms)
          </code>
        ))}
      </section>

      <section>
        <h2>2 · Setup (needs Wi-Fi, once)</h2>
        <button onClick={enablePersistence} disabled={!!busy}>Request persistent storage</button>
        <div className="row">
          {(['tiny', 'base', 'small'] as WhisperVariant[]).map((v) => (
            <button
              key={v}
              className={variant === v ? 'sel' : ''}
              onClick={() => {
                setVariant(v);
                setSttVariant(v);
              }}
              disabled={!!busy}
            >
              whisper {v}
            </button>
          ))}
        </div>
        <div className="row">
          {(['wasm', 'webgpu'] as SttDevice[]).map((d) => (
            <button
              key={d}
              className={sttDevice === d ? 'sel' : ''}
              onClick={() => {
                setSttDeviceState(d);
                setSttDevice(d);
              }}
              disabled={!!busy}
            >
              {d}
            </button>
          ))}
        </div>
        <code>
          Changing model or backend needs a reload before it takes effect — the loaded session
          stays in memory until then.
        </code>
        <button onClick={downloadModels} disabled={!!busy}>Download all models</button>
        <button onClick={armOffline} disabled={!!busy}>Arm offline mode</button>
        <button onClick={wipeModels} disabled={!!busy}>Delete cached models</button>
        <button onClick={() => void forceUpdate()} disabled={!!busy}>
          Force fresh app download (keeps models)
        </button>
        <code>cache: {formatBytes(cacheSize)}</code>
        <code>build {__BUILD_ID__}</code>
      </section>

      <section>
        <h2>3 · Speech to text</h2>
        <div className="row">
          {(['auto', 'whisper', 'platform'] as SttEngineChoice[]).map((c) => (
            <button key={c} className={sttChoice === c ? 'sel' : ''} onClick={() => setSttChoice(c)} disabled={!!busy}>
              {c}
            </button>
          ))}
        </div>
        <button onClick={loadWhisper} disabled={!!busy}>Load Whisper {variant}</button>
        <button onClick={benchmarkStt} disabled={!!busy}>Benchmark speech model</button>
        <div className="row">
          <button onClick={() => setUtterance(EN_UTTERANCES[0])} disabled={!!busy}>EN set</button>
          <button onClick={() => setUtterance(RU_UTTERANCES[0])} disabled={!!busy}>RU set</button>
        </div>
        {utteranceList.map((u) => (
          <button
            key={u.id}
            className={`utt ${utterance.id === u.id ? 'sel' : ''}`}
            onClick={() => setUtterance(u)}
            disabled={!!busy}
          >
            {u.say}
          </button>
        ))}
        <button
          className={`ptt ${recording ? 'rec' : ''}`}
          onPointerDown={startRecording}
          onPointerUp={stopRecordingAndTranscribe}
          onPointerLeave={() => recording && stopRecordingAndTranscribe()}
        >
          {recording ? 'RECORDING — release to transcribe' : 'HOLD TO SPEAK'}
        </button>
        {recording && <button onClick={cancelRecording}>Cancel</button>}
        {transcript && <p className="result">Heard: {transcript}</p>}
      </section>

      <section>
        <h2>4 · Translation</h2>
        <div className="row">
          <button onClick={() => testTranslate('en', 'ru')} disabled={!!busy}>EN → RU</button>
          <button onClick={() => testTranslate('ru', 'en')} disabled={!!busy}>RU → EN</button>
        </div>
        {translation && <p className="result">{translation}</p>}
        {backTranslation && <p className="back">round-trip: {backTranslation}</p>}
      </section>

      <section>
        <h2>5 · Text to speech</h2>
        <button onClick={loadVoices} disabled={!!busy}>Inspect voices</button>
        {voices
          .filter((v) => /^(ru|en)/i.test(v.language))
          .slice(0, 12)
          .map((v) => (
            <code key={v.id}>
              {v.networkConnectionRequired === false ? '✓ local' : '✗ remote'} · {v.language} · {v.name}
            </code>
          ))}
        <div className="row">
          <button onClick={() => testTts('en')} disabled={!!busy}>Speak English</button>
          <button onClick={() => testTts('ru')} disabled={!!busy}>Speak Russian</button>
        </div>
      </section>

      <section>
        <h2>6 · Full pipeline</h2>
        <p className="hint">Record an utterance in step 3 first; the pipeline reuses it.</p>
        <div className="row">
          <button onClick={() => runPipeline('en')} disabled={!!busy}>EN → RU</button>
          <button onClick={() => runPipeline('ru')} disabled={!!busy}>RU → EN</button>
        </div>
      </section>

      <section>
        <h2>
          7 · Report — {summary.pass} pass, {summary.fail} fail, {summary.invalid} invalid
        </h2>
        {pageLoads > 1 && (
          <p className="hint">
            Page load #{pageLoads} for this session — results and log were restored from storage.
            If you did not reload deliberately, the tab was killed, most likely for memory.
          </p>
        )}
        <div className="row">
          <button onClick={copyReport} disabled={!!busy}>Copy report</button>
          <button onClick={shareReport} disabled={!!busy}>Share / download</button>
        </div>
        <button
          onClick={() => {
            clearSession();
            setResults([]);
            setTimings({});
            setLog([]);
            say('Stored session cleared. Reload to reset the page-load counter.');
          }}
          disabled={!!busy}
        >
          Clear stored results
        </button>
        {results.map((r) => (
          <code key={r.id}>
            [{r.status}] {r.label} {r.ms !== undefined ? `${Math.round(r.ms)}ms` : ''}
          </code>
        ))}
      </section>

      <section>
        <h2>Log</h2>
        {log.map((l, i) => (
          <code key={i} className="log">{l}</code>
        ))}
      </section>
    </main>
  );
}
