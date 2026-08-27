import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { EN_UTTERANCES, RU_UTTERANCES, TTS_PROBES, type Utterance } from '@core/corpus';
import { collectDeviceInfo, formatBytes, peakMemoryNote } from './src/device';
import { exportReport } from './src/exportReport';
import { MlKitTranslationEngine } from './src/engines/mt';
import {
  MODEL_FILES,
  VAD_MODEL_FILE,
  WhisperSpeechRecognizer,
  inspectModels,
  modelsDirectory,
} from './src/engines/stt';
import { NativeSpeechSynthesizer } from './src/engines/tts';
import {
  getJsRequestCount,
  installJsNetworkCounter,
  probeNetworkUncounted,
} from '@core/netprobe';
import { PcmRecorder, MAX_RECORDING_MS } from './src/audio';
import { summarise } from '@core/report';
import type {
  DeviceInfo,
  Lang,
  NetworkProbeResult,
  Phase0Report,
  StageTiming,
  TestResult,
  TestStatus,
  WhisperVariant,
} from '@core/types';

installJsNetworkCounter();

const APP_VERSION = 'phase0-spike-0.1.0';

const stt = new WhisperSpeechRecognizer();
const mt = new MlKitTranslationEngine();
const tts = new NativeSpeechSynthesizer();
const recorder = new PcmRecorder();

export default function App() {
  const [device] = useState<DeviceInfo>(() => collectDeviceInfo(APP_VERSION));
  const [variant, setVariant] = useState<WhisperVariant>('small');
  const [probe, setProbe] = useState<NetworkProbeResult | null>(null);
  const [results, setResults] = useState<TestResult[]>([]);
  const [timings, setTimings] = useState<Record<string, StageTiming>>({});
  const [notes, setNotes] = useState<string[]>([peakMemoryNote()]);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [utterance, setUtterance] = useState<Utterance>(EN_UTTERANCES[0]);
  const [transcript, setTranscript] = useState('');
  const [translation, setTranslation] = useState('');
  const [backTranslation, setBackTranslation] = useState('');
  const [models, setModels] = useState(() => inspectModels());
  const [voices, setVoices] = useState<Phase0Report['voices']>([]);

  const lastWav = useRef<string | null>(null);

  const say = useCallback((line: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 200));
  }, []);

  const offlineVerified = probe?.offline ?? false;

  const record = useCallback(
    (id: string, label: string, status: TestStatus, ms?: number, detail?: string, error?: string) => {
      // An offline claim made while the network was reachable is not a pass.
      const needsOffline = id.includes('offline') || id.startsWith('pipeline') || id.includes('cold-start');
      const finalStatus: TestStatus =
        status === 'PASS' && needsOffline && !offlineVerified ? 'INVALID' : status;
      const entry: TestResult = {
        id,
        label,
        status: finalStatus,
        ms,
        offlineVerified,
        detail,
        error,
        at: new Date().toISOString(),
      };
      setResults((prev) => [...prev.filter((r) => r.id !== id), entry]);
      say(`${finalStatus}  ${label}${ms !== undefined ? ` (${Math.round(ms)}ms)` : ''}`);
      return entry;
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
        Alert.alert(name, e?.message ?? String(e));
      } finally {
        setBusy(null);
      }
    },
    [busy, say]
  );

  // ---------------------------------------------------------------- permissions

  useEffect(() => {
    (async () => {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: 'Microphone',
            message: 'The spike needs the microphone to test speech recognition.',
            buttonPositive: 'OK',
          }
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          say('Microphone permission DENIED — every STT test will fail.');
          return;
        }
      }
      recorder.init();
      say('Recorder initialised at 16 kHz mono, AudioSource.VOICE_RECOGNITION.');
    })().catch((e) => say(`Permission setup failed: ${e?.message ?? e}`));
  }, [say]);

  // ---------------------------------------------------------------- steps

  const runProbe = () =>
    guard('Network probe', async () => {
      const p = await probeNetworkUncounted();
      setProbe(p);
      say(
        p.offline
          ? 'Offline confirmed — no probe target reachable. Offline results are trustworthy.'
          : 'NETWORK REACHABLE — offline results will be stamped INVALID. Enable Airplane Mode.'
      );
    });

  const downloadMlKit = () =>
    guard('ML Kit download', async () => {
      say('Downloading ML Kit language models (needs Wi-Fi)…');
      await mt.downloadBothLanguages((m) => say(`  ${m}`));
      const list = await mt.listDownloaded();
      say(`Downloaded models: ${list.join(', ') || 'none reported'}`);
    });

  const refreshModels = () => {
    setModels(inspectModels());
    say(`Model directory: ${modelsDirectory().uri}`);
  };

  const loadWhisper = () =>
    guard('Load Whisper', async () => {
      const outcome = await stt.initialize(variant);
      record(
        'whisper-load',
        `Whisper ${variant} loads`,
        'PASS',
        outcome.loadMs,
        `backend=${outcome.gpu ? 'gpu' : 'cpu'}${
          outcome.reasonNoGPU ? ` (${outcome.reasonNoGPU})` : ''
        }, coreML=${outcome.coreMLCompiled}, model=${formatBytes(outcome.modelSizeBytes)}, vad=${
          stt.hasVad ? 'yes' : 'MISSING'
        }, whisper.cpp=${outcome.libVersion}`
      );
      if (!stt.hasVad) {
        setNotes((n) => [
          ...n,
          `${VAD_MODEL_FILE} is missing — the VAD hallucination guard is DISABLED for this run.`,
        ]);
      }
    });

  const startRecording = async () => {
    if (!stt.isReady) {
      Alert.alert('Load Whisper first');
      return;
    }
    setTranscript('');
    setTranslation('');
    setBackTranslation('');
    await activateKeepAwakeAsync('ptt').catch(() => undefined);
    recorder.start();
    setRecording(true);
  };

  const stopRecordingAndTranscribe = () =>
    guard('Transcribe', async () => {
      setRecording(false);
      const rec = await recorder.stop();
      deactivateKeepAwake('ptt').catch(() => undefined);
      lastWav.current = rec.uri;
      say(`Recorded ${rec.durationMs}ms, ${formatBytes(rec.byteLength)}${rec.truncated ? ' (TRUNCATED at max duration)' : ''}`);

      const { outcome, timing } = await stt.transcribe(rec.uri, utterance.lang);
      setTranscript(outcome.rejected ? `[rejected: ${outcome.rejectReason}]` : outcome.text);

      const id = utterance.lang === 'en' ? 'stt-en-offline' : 'stt-ru-offline';
      const label = utterance.lang === 'en' ? 'English STT offline' : 'Russian STT offline';
      record(
        id,
        label,
        outcome.rejected ? 'FAIL' : 'PASS',
        timing.sttMs,
        outcome.rejected
          ? `rejected: ${outcome.rejectReason}`
          : `heard "${outcome.text}" | expected "${utterance.say}" | backend=${outcome.backend} | speech=${
              timing.speechMs === null ? 'n/a' : `${Math.round(timing.speechMs)}ms`
            }`
      );
      record(
        `utt-${utterance.id}`,
        `${utterance.id}: ${utterance.say}`,
        outcome.rejected ? 'FAIL' : 'PASS',
        timing.sttMs,
        outcome.rejected ? outcome.rejectReason : outcome.text
      );
      setTimings((t) => ({
        ...t,
        [utterance.id]: {
          recordMs: rec.durationMs,
          vadMs: timing.vadMs,
          sttMs: timing.sttMs,
        },
      }));
    });

  const cancelRecording = async () => {
    await recorder.cancel();
    setRecording(false);
    deactivateKeepAwake('ptt').catch(() => undefined);
    say('Recording cancelled.');
  };

  const testTranslate = (from: Lang, to: Lang) =>
    guard(`Translate ${from}->${to}`, async () => {
      const source = from === 'en' ? EN_UTTERANCES[0].say : RU_UTTERANCES[0].say;
      const rt = await mt.roundTrip(source, from, to);
      setTranslation(rt.forward);
      setBackTranslation(rt.back);
      record(
        from === 'en' ? 'mt-en-ru-offline' : 'mt-ru-en-offline',
        from === 'en' ? 'ML Kit EN→RU offline' : 'ML Kit RU→EN offline',
        'PASS',
        rt.forwardMs,
        `"${source}" → "${rt.forward}" | round-trip back: "${rt.back}"`
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
      const ru = list.filter((v) => v.language.toLowerCase().startsWith('ru'));
      const en = list.filter((v) => v.language.toLowerCase().startsWith('en'));
      say(`Found ${list.length} voices — ${en.length} English, ${ru.length} Russian.`);
      for (const lang of ['en', 'ru'] as Lang[]) {
        const problem = tts.diagnose(lang);
        if (problem) say(`${lang.toUpperCase()} TTS problem: ${problem}`);
      }
    });

  const testTts = (lang: Lang) =>
    guard(`TTS ${lang}`, async () => {
      if (!tts.isReady) await tts.initialize();
      const outcome = await tts.speak(TTS_PROBES[lang], lang);
      record(
        lang === 'en' ? 'tts-en-offline' : 'tts-ru-offline',
        lang === 'en' ? 'English TTS offline' : 'Russian TTS offline',
        'PASS',
        outcome.firstAudioMs,
        `voice=${outcome.voiceId}, offlineFlag=${outcome.offlineCapable}, total=${outcome.totalMs}ms`
      );
    });

  const runPipeline = (from: Lang) =>
    guard(`Pipeline ${from}`, async () => {
      if (!lastWav.current) {
        throw new Error('Record an utterance first — the pipeline reuses the last recording.');
      }
      const to: Lang = from === 'en' ? 'ru' : 'en';
      const t0 = Date.now();

      const { outcome, timing } = await stt.transcribe(lastWav.current, from);
      if (outcome.rejected) {
        record(
          from === 'en' ? 'pipeline-en-ru' : 'pipeline-ru-en',
          from === 'en' ? 'Complete EN→RU pipeline' : 'Complete RU→EN pipeline',
          'FAIL',
          Date.now() - t0,
          undefined,
          `STT rejected: ${outcome.rejectReason}`
        );
        return;
      }
      setTranscript(outcome.text);

      const tMt = Date.now();
      const translated = await mt.translate(outcome.text, from, to);
      const translateMs = Date.now() - tMt;
      setTranslation(translated);

      if (!tts.isReady) await tts.initialize();
      const spoken = await tts.speak(translated, to);
      const totalMs = Date.now() - t0;

      record(
        from === 'en' ? 'pipeline-en-ru' : 'pipeline-ru-en',
        from === 'en' ? 'Complete EN→RU pipeline' : 'Complete RU→EN pipeline',
        'PASS',
        totalMs,
        `"${outcome.text}" → "${translated}" (stt ${Math.round(timing.sttMs)}ms, mt ${translateMs}ms, tts ${Math.round(
          spoken.firstAudioMs
        )}ms)`
      );
      setTimings((t) => ({
        ...t,
        [`pipeline-${from}`]: {
          vadMs: timing.vadMs,
          sttMs: timing.sttMs,
          translateMs,
          ttsFirstAudioMs: spoken.firstAudioMs,
          totalMs,
        },
      }));
    });

  const markColdStart = () =>
    guard('Cold start', async () => {
      const p = await probeNetworkUncounted();
      setProbe(p);
      if (!p.offline) {
        record('cold-start-airplane', 'Airplane Mode cold start', 'INVALID', undefined, undefined, 'Network was reachable.');
        return;
      }
      const t0 = Date.now();
      const outcome = await stt.initialize(variant);
      const modelsOk = inspectModels().filter((m) => m.present).length;
      const pairOk = await mt.isPairAvailable('en', 'ru');
      await tts.initialize();
      const ttsOk = tts.diagnose('ru') === null && tts.diagnose('en') === null;
      const ok = modelsOk > 0 && pairOk && ttsOk;
      record(
        'cold-start-airplane',
        'Airplane Mode cold start',
        ok ? 'PASS' : 'FAIL',
        Date.now() - t0,
        `whisperLoad=${outcome.loadMs}ms, mlkitPair=${pairOk}, ttsUsable=${ttsOk}`
      );
    });

  const doExport = () =>
    guard('Export report', async () => {
      const report: Phase0Report = {
        generatedAt: new Date().toISOString(),
        device,
        whisperVariant: variant,
        // Null when never run. Never substitute a default — a zero-value probe
        // renders as "network was reachable", which reads like evidence.
        networkProbe: probe,
        results,
        timings,
        voices,
        notes: [
          ...notes,
          `JS-layer outbound requests observed: ${getJsRequestCount()} (does NOT cover native libraries).`,
          `Max recording duration: ${MAX_RECORDING_MS}ms.`,
        ],
        // The error messages that explain a failed run live here and nowhere else.
        log,
      };
      const out = await exportReport(report);
      say(`Report written to ${out.markdownUri}`);
    });

  const summary = useMemo(() => summarise(results), [results]);
  const utteranceList = utterance.lang === 'en' ? EN_UTTERANCES : RU_UTTERANCES;

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.h1}>Phase 0 spike</Text>

        <View style={[styles.banner, offlineVerified ? styles.bannerOk : styles.bannerWarn]}>
          <Text style={styles.bannerText}>
            {probe === null
              ? 'Network state unknown — run the probe before trusting any result.'
              : offlineVerified
              ? 'OFFLINE CONFIRMED — results are trustworthy'
              : 'NETWORK REACHABLE — offline results will be marked INVALID'}
          </Text>
        </View>

        <Section title="Device">
          <KV k="Model" v={`${device.brand ?? ''} ${device.modelName}`.trim()} />
          <KV k="OS" v={`${device.platform} ${device.osVersion}`} />
          <KV k="RAM" v={formatBytes(device.totalMemoryBytes)} />
          <KV k="CPU" v={device.supportedCpuArchitectures?.join(', ') ?? 'unknown'} />
          <KV k="Storage" v={`${formatBytes(device.freeStorageBytes)} free`} />
          <KV k="Physical" v={device.isDevice ? 'yes' : 'NO — simulator'} />
        </Section>

        <Section title="1 · Network probe">
          <Btn label="Run network probe" onPress={runProbe} busy={busy} />
          {probe?.attempts.map((a) => (
            <Text key={a.target} style={styles.mono}>
              {a.target}: {a.reachable ? 'REACHABLE' : 'unreachable'} ({a.ms}ms)
            </Text>
          ))}
        </Section>

        <Section title="2 · Setup (needs Wi-Fi, once)">
          <Btn label="Download ML Kit EN + RU models" onPress={downloadMlKit} busy={busy} />
          <Btn label="Re-check Whisper model files" onPress={refreshModels} busy={busy} />
          {models.map((m) => (
            <Text key={m.name} style={styles.mono}>
              {m.present ? '✓' : '✗'} {m.name} {m.present ? formatBytes(m.sizeBytes) : '— MISSING'}
            </Text>
          ))}
          <Text style={styles.hint}>Push model files to: {modelsDirectory().uri}</Text>
        </Section>

        <Section title="3 · Whisper">
          <Row>
            {(['small', 'base'] as WhisperVariant[]).map((v) => (
              <Btn
                key={v}
                label={`${v}${variant === v ? ' ✓' : ''}`}
                onPress={async () => setVariant(v)}
                busy={busy}
                small
              />
            ))}
          </Row>
          <Text style={styles.hint}>{MODEL_FILES[variant]}</Text>
          <Btn label={`Load Whisper ${variant}`} onPress={loadWhisper} busy={busy} />
        </Section>

        <Section title="4 · Speech to text">
          <Row>
            <Btn
              label="EN set"
              small
              busy={busy}
              onPress={async () => setUtterance(EN_UTTERANCES[0])}
            />
            <Btn
              label="RU set"
              small
              busy={busy}
              onPress={async () => setUtterance(RU_UTTERANCES[0])}
            />
          </Row>
          {utteranceList.map((u) => (
            <Pressable key={u.id} onPress={() => setUtterance(u)}>
              <Text style={[styles.utt, utterance.id === u.id && styles.uttActive]}>
                {utterance.id === u.id ? '▶ ' : '  '}
                {u.say}
              </Text>
            </Pressable>
          ))}
          <Pressable
            onPressIn={startRecording}
            onPressOut={stopRecordingAndTranscribe}
            style={[styles.ptt, recording && styles.pttActive]}
          >
            <Text style={styles.pttText}>
              {recording ? 'RECORDING — release to transcribe' : 'HOLD TO SPEAK'}
            </Text>
          </Pressable>
          {recording && <Btn label="Cancel" onPress={cancelRecording} busy={null} small />}
          {transcript !== '' && <Text style={styles.result}>Heard: {transcript}</Text>}
        </Section>

        <Section title="5 · Translation">
          <Row>
            <Btn label="EN → RU" small busy={busy} onPress={() => testTranslate('en', 'ru')} />
            <Btn label="RU → EN" small busy={busy} onPress={() => testTranslate('ru', 'en')} />
          </Row>
          {translation !== '' && <Text style={styles.result}>{translation}</Text>}
          {backTranslation !== '' && (
            <Text style={styles.backTranslation}>round-trip: {backTranslation}</Text>
          )}
        </Section>

        <Section title="6 · Text to speech">
          <Btn label="Inspect available voices" onPress={loadVoices} busy={busy} />
          {voices
            .filter((v) => /^(ru|en)/i.test(v.language))
            .slice(0, 12)
            .map((v) => (
              <Text key={v.id} style={styles.mono}>
                {v.networkConnectionRequired === true || v.notInstalled === true ? '✗' : '✓'}{' '}
                {v.language} {v.name}
                {v.networkConnectionRequired === null ? ' (offline flag unknown)' : ''}
              </Text>
            ))}
          <Row>
            <Btn label="Speak English" small busy={busy} onPress={() => testTts('en')} />
            <Btn label="Speak Russian" small busy={busy} onPress={() => testTts('ru')} />
          </Row>
        </Section>

        <Section title="7 · Full pipeline">
          <Text style={styles.hint}>Record an utterance in step 4 first; the pipeline reuses it.</Text>
          <Row>
            <Btn label="EN → RU" small busy={busy} onPress={() => runPipeline('en')} />
            <Btn label="RU → EN" small busy={busy} onPress={() => runPipeline('ru')} />
          </Row>
        </Section>

        <Section title="8 · Cold start in Airplane Mode">
          <Text style={styles.hint}>
            Force-quit the app, enable Airplane Mode, relaunch, then press this first.
          </Text>
          <Btn label="Run cold-start check" onPress={markColdStart} busy={busy} />
        </Section>

        <Section title={`9 · Report — ${summary.pass} pass, ${summary.fail} fail, ${summary.invalid} invalid`}>
          <Btn label="Export report (.md + .json)" onPress={doExport} busy={busy} />
          {results.map((r) => (
            <Text key={r.id} style={styles.mono}>
              [{r.status}] {r.label} {r.ms !== undefined ? `${Math.round(r.ms)}ms` : ''}
            </Text>
          ))}
        </Section>

        <Section title="Log">
          {log.map((l, i) => (
            <Text key={i} style={styles.logLine}>
              {l}
            </Text>
          ))}
        </Section>
      </ScrollView>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.h2}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <Text style={styles.mono}>
      {k}: {v}
    </Text>
  );
}

function Btn({
  label,
  onPress,
  busy,
  small,
}: {
  label: string;
  onPress: () => void | Promise<void>;
  busy: string | null;
  small?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy !== null}
      style={[styles.btn, small && styles.btnSmall, busy !== null && styles.btnDisabled]}
    >
      <Text style={styles.btnText}>{busy !== null ? `${busy}…` : label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#10161a' },
  scroll: { padding: 16, paddingTop: 56, paddingBottom: 64 },
  h1: { color: '#e8eef2', fontSize: 26, fontWeight: '700', marginBottom: 12 },
  h2: { color: '#8fd4b4', fontSize: 15, fontWeight: '700', marginBottom: 8 },
  section: {
    backgroundColor: '#18232a',
    borderRadius: 6,
    padding: 14,
    marginBottom: 12,
    gap: 6,
  },
  banner: { borderRadius: 6, padding: 12, marginBottom: 12 },
  bannerOk: { backgroundColor: '#123d2e' },
  bannerWarn: { backgroundColor: '#4a2016' },
  bannerText: { color: '#f0f4f2', fontWeight: '700', fontSize: 14 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  btn: {
    backgroundColor: '#22323b',
    borderRadius: 4,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 4,
  },
  btnSmall: { paddingVertical: 9, flexGrow: 1 },
  btnDisabled: { opacity: 0.45 },
  btnText: { color: '#dbe7ee', fontWeight: '600', textAlign: 'center' },
  ptt: {
    backgroundColor: '#1d4d3a',
    borderRadius: 6,
    paddingVertical: 28,
    marginTop: 10,
    alignItems: 'center',
  },
  pttActive: { backgroundColor: '#a33a26' },
  pttText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  mono: { color: '#9fb3bf', fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 11.5 },
  hint: { color: '#6f8592', fontSize: 11.5, fontStyle: 'italic' },
  utt: { color: '#b9c9d3', fontSize: 13, paddingVertical: 3 },
  uttActive: { color: '#8fd4b4', fontWeight: '700' },
  result: { color: '#f2f6f8', fontSize: 17, marginTop: 8, lineHeight: 24 },
  backTranslation: { color: '#8ba3b0', fontSize: 13, fontStyle: 'italic' },
  logLine: { color: '#7f95a2', fontSize: 11, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
});
