import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { Lang, WhisperVariant } from '@core/types';
import { mt, recorder, tts, whisper } from './engines/singletons';
import { setOfflineMode, withDownloadsAllowed } from './transformersEnv';
import { MAX_RECORDING_MS } from './audio';
import {
  getLastWarmUpMs,
  getSttDevice,
  getSttVariant,
  setLastWarmUpMs,
  setSttVariant,
} from './settings';
import { forceUpdate } from './updateApp';
import { buildLabel } from './buildInfo';
import { logEvent } from './eventLog';

/**
 * Above this, a one-second clip is taking long enough that real sentences will
 * be unusable, and the honest move is to offer a smaller model rather than let
 * someone discover it in a train station.
 */
const SLOW_WARMUP_MS = 8000;

type InputMode = 'voice' | 'text';
type OutputMode = 'voice' | 'text';
type Phase = 'idle' | 'recording' | 'thinking' | 'ready' | 'error';

const LABEL: Record<Lang, string> = { en: 'English', ru: 'Русский' };
const FLAG: Record<Lang, string> = { en: '🇬🇧', ru: '🇷🇺' };

interface Turn {
  source: string;
  translation: string;
  backTranslation: string | null;
  from: Lang;
  to: Lang;
  ms: number;
}

export default function Translator({ onOpenDiagnostics }: { onOpenDiagnostics: () => void }) {
  const reduce = useReducedMotion();

  const [from, setFrom] = useState<Lang>('en');
  const to: Lang = from === 'en' ? 'ru' : 'en';

  const [inputMode, setInputMode] = useState<InputMode>('voice');
  const [outputMode, setOutputMode] = useState<OutputMode>('voice');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [speakError, setSpeakError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [elapsed, setElapsed] = useState(0);

  // Two readiness flags, not one. Typing needs only the translation model,
  // which loads in seconds; speech needs Whisper, which does not. Gating the
  // whole screen on the slowest of them is what produced a four-minute wait.
  const [mtReady, setMtReady] = useState(false);
  const [sttReady, setSttReady] = useState(false);
  const [mtProgress, setMtProgress] = useState<number | null>(null);
  const [sttProgress, setSttProgress] = useState<number | null>(null);
  const [warmUpMs, setWarmUpMs] = useState<number | null>(getLastWarmUpMs());
  const activeVariant = getSttVariant();

  const recordingRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ------------------------------------------------------------ model setup */

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Stage 1 — the active direction only. Enough to type and translate.
        await withDownloadsAllowed(() =>
          mt.load(from, to, (p) => !cancelled && setMtProgress(p.progress))
        );
        if (cancelled) return;
        setMtProgress(null);
        setMtReady(true);

        tts.initialize().catch(() => undefined);

        // Stage 2 — speech, in the background. The screen is already usable.
        const device = getSttDevice();
        const variant = getSttVariant();
        await withDownloadsAllowed(() =>
          whisper.load(variant, device, (p) => !cancelled && setSttProgress(p.progress))
        );
        if (cancelled) return;
        setSttProgress(null);
        setSttReady(true);

        // The reverse direction is NOT loaded here. It is another ~75 MB, and
        // on a slow connection it doubled the wait for something only needed
        // after the user switches direction. It loads on demand instead.
        //
        // Everything needed to translate is present, so close the door: from
        // here a missing file is an error, never a quiet fetch.
        setOfflineMode(true);

        // Stage 3 — warm-up last, and deliberately not awaited by anything the
        // user is waiting on. It pays the one-off shader/kernel compilation so
        // the first real utterance is not the slowest, but blocking startup on
        // it bought nothing and cost minutes.
        whisper
          .warmUp('en')
          .then((ms) => {
            if (cancelled) return;
            setWarmUpMs(ms);
            setLastWarmUpMs(ms);
          })
          .catch(() => undefined);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
    // Runs once. Switching direction reuses already-loaded pipelines.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------- the pipeline */

  const translateText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        setError('Nothing to translate.');
        setPhase('error');
        return;
      }
      setPhase('thinking');
      setError(null);
      const started = performance.now();
      try {
        // The forward direction is always loaded; the reverse may still be
        // arriving, so the meaning check degrades rather than blocking.
        const forward = await mt.translate(trimmed, from, to);
        let back: string | null = null;
        if (mt.isLoaded(to, from)) {
          back = (await mt.translate(forward.text, to, from).catch(() => null))?.text ?? null;
        }

        setTurn({
          source: trimmed,
          translation: forward.text,
          backTranslation: back,
          from,
          to,
          ms: performance.now() - started,
        });
        setPhase('ready');
        setSpeakError(null);

        if (outputMode === 'voice') {
          // Kept apart from `error`: a failure to speak must not hide the
          // translation. The text is the thing you can still hold up to
          // someone; the audio is a convenience on top of it.
          tts.speak(forward.text, to).catch((e: any) =>
            setSpeakError(`Couldn't speak it — ${e?.message ?? e}`)
          );
        }
      } catch (e: any) {
        setError(e?.message ?? String(e));
        setPhase('error');
      }
    },
    [from, to, outputMode]
  );

  const startRecording = useCallback(async () => {
    if (!sttReady || recordingRef.current) return;
    recordingRef.current = true;
    setError(null);
    setTurn(null);
    setPhase('recording');
    setElapsed(0);
    tickRef.current = setInterval(() => setElapsed((e) => e + 100), 100);
    try {
      await recorder.start();
    } catch (e: any) {
      recordingRef.current = false;
      setPhase('error');
      setError(`Microphone unavailable: ${e?.message ?? e}`);
    }
  }, [sttReady]);

  const stopAndTranslate = useCallback(async () => {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    setPhase('thinking');

    try {
      const rec = await recorder.stop();
      const res = await whisper.transcribe(rec.samples, from);

      /**
       * Every transcription is recorded with the conditions that produced it.
       *
       * Speech was reported as good online and poor offline, which no code path
       * explains — the translator only ever calls Whisper, and Whisper never
       * touches the network once loaded. The likelier explanation is that the
       * two runs used different models. Without this line there is no way to
       * tell those apart afterwards, so it goes in the log and the report.
       */
      logEvent(
        `STT ${from} · model=${getSttVariant()} · ${whisper.activeDevice}/${whisper.activeDtype} · ` +
          `audio=${Math.round(rec.durationMs)}ms · online=${navigator.onLine} · ` +
          `${res.outcome.rejected ? `REJECTED (${res.outcome.rejectReason})` : `"${res.outcome.text}"`} · ` +
          `${Math.round(res.sttMs)}ms`
      );

      if (res.outcome.rejected) {
        setPhase('error');
        setError(`Didn't catch that — ${res.outcome.rejectReason}. Try again, a little closer.`);
        return;
      }
      await translateText(res.outcome.text);
    } catch (e: any) {
      setPhase('error');
      setError(e?.message ?? String(e));
    }
  }, [from, translateText]);

  const replay = useCallback(() => {
    if (!turn) return;
    tts.unlock();
    setSpeakError(null);
    tts.speak(turn.translation, turn.to).catch((e: any) =>
      setSpeakError(`Couldn't speak it — ${e?.message ?? e}`)
    );
  }, [turn]);

  /**
   * Load a direction on demand.
   *
   * Remote loading is re-enabled only for the duration of an explicitly
   * requested download and switched straight back off, so the "no silent
   * fetch" guarantee survives while a genuine one-time download can still
   * happen when someone asks for it.
   */
  const ensureDirection = useCallback(async (f: Lang, t: Lang) => {
    if (mt.isLoaded(f, t)) return;
    try {
      await withDownloadsAllowed(() => mt.load(f, t, (p) => setMtProgress(p.progress)));
    } finally {
      setMtProgress(null);
    }
  }, []);

  const swap = useCallback(() => {
    const nextFrom: Lang = from === 'en' ? 'ru' : 'en';
    const nextTo: Lang = nextFrom === 'en' ? 'ru' : 'en';
    setFrom(nextFrom);
    setTurn(null);
    setTyped('');
    setError(null);
    setPhase('idle');

    if (!mt.isLoaded(nextFrom, nextTo)) {
      ensureDirection(nextFrom, nextTo).catch((e: any) =>
        setError(
          `${LABEL[nextFrom]} → ${LABEL[nextTo]} needs a one-time download and it did not ` +
            `complete: ${e?.message ?? e}`
        )
      );
    }
  }, [from, ensureDirection]);

  useEffect(() => () => void (tickRef.current && clearInterval(tickRef.current)), []);

  const recSeconds = (elapsed / 1000).toFixed(1);
  const nearLimit = elapsed > MAX_RECORDING_MS - 3000;
  const slowSpeech =
    warmUpMs !== null && warmUpMs > SLOW_WARMUP_MS && getSttVariant() !== 'tiny';

  const pill = sttReady
    ? { text: '● Offline ready', cls: 'ok' }
    : mtReady
    ? { text: '◐ Typing ready · speech loading', cls: 'part' }
    : { text: '○ Preparing', cls: '' };

  const idleHint = sttReady
    ? warmUpMs !== null
      ? `Ready — works with no connection · ${whisper.activeDevice}/${whisper.activeDtype}, ${(
          warmUpMs / 1000
        ).toFixed(1)}s per second of audio`
      : 'Ready — works with no connection'
    : mtReady
    ? sttProgress !== null
      ? `Speech model ${Math.round(sttProgress)}% — you can type in the meantime`
      : 'Loading speech model — you can type in the meantime'
    : mtProgress !== null
    ? `Loading translation ${Math.round(mtProgress)}%`
    : 'Loading translation…';

  /* ------------------------------------------------------------------- render */

  return (
    <div className="t-root">
      <header className="t-top">
        <motion.span
          className={`t-pill ${pill.cls}`}
          animate={reduce ? undefined : { opacity: sttReady ? 1 : [0.5, 1, 0.5] }}
          transition={{ duration: 1.6, repeat: sttReady ? 0 : Infinity }}
        >
          {pill.text}
        </motion.span>
        <div className="t-top-right">
          <button className="t-ghost" onClick={onOpenDiagnostics} aria-label="Open diagnostics">
            Diagnostics
          </button>
          {/* The running build, visible at a glance. A stale service worker and
              a real bug look identical without this. */}
          <button
            className="t-build"
            onClick={() => void forceUpdate()}
            title="Tap to force a fresh download of the app"
          >
            build {buildLabel()} · refresh
          </button>
        </div>
      </header>

      <AnimatePresence>
        {slowSpeech && (
          <motion.div
            className="t-slow"
            initial={reduce ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduce ? undefined : { opacity: 0, height: 0 }}
          >
            <span>
              Speech is slow on this phone — {(warmUpMs! / 1000).toFixed(1)}s for a one-second
              clip on <code>{whisper.activeDevice}</code>.
            </span>
            <button
              onClick={() => {
                setSttVariant('tiny');
                void forceUpdate();
              }}
            >
              Switch to the faster model
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <button className="t-direction" onClick={swap} aria-label="Swap language direction">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={from}
            className="t-dir-lang"
            initial={reduce ? false : { y: 14, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduce ? undefined : { y: -14, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 32 }}
          >
            {FLAG[from]} {LABEL[from]}
          </motion.span>
        </AnimatePresence>
        <motion.span
          className="t-swap"
          key={`arrow-${from}`}
          initial={reduce ? false : { rotate: -180 }}
          animate={{ rotate: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 22 }}
          aria-hidden="true"
        >
          ⇄
        </motion.span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={to}
            className="t-dir-lang"
            initial={reduce ? false : { y: -14, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduce ? undefined : { y: 14, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 32 }}
          >
            {FLAG[to]} {LABEL[to]}
          </motion.span>
        </AnimatePresence>
      </button>

      <div className="t-stage">
        <AnimatePresence mode="wait">
          {error && (
            <motion.p
              key="error"
              className="t-error"
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              {error}
            </motion.p>
          )}

          {!error && phase === 'thinking' && (
            <motion.div
              key="thinking"
              className="t-thinking"
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduce ? undefined : { opacity: 0 }}
            >
              <motion.span
                animate={reduce ? undefined : { opacity: [0.35, 1, 0.35] }}
                transition={{ duration: 1.1, repeat: Infinity }}
              >
                Translating…
              </motion.span>
            </motion.div>
          )}

          {!error && phase === 'ready' && turn && (
            <motion.div
              key="result"
              className="t-result"
              initial={reduce ? false : { opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, y: -8 }}
              transition={{ type: 'spring', stiffness: 320, damping: 30 }}
            >
              <p className="t-source">{turn.source}</p>
              <p className="t-translation" lang={turn.to}>
                {turn.translation}
              </p>
              {turn.backTranslation && (
                <p className="t-back">
                  <span className="t-back-label">meaning check</span>
                  {turn.backTranslation}
                </p>
              )}
              {speakError && <p className="t-speak-error">{speakError}</p>}
              <div className="t-result-actions">
                <motion.button
                  className="t-speak"
                  onClick={replay}
                  whileTap={reduce ? undefined : { scale: 0.96 }}
                >
                  🔊 Play again
                </motion.button>
                <span className="t-timing">{Math.round(turn.ms)} ms</span>
              </div>
            </motion.div>
          )}

          {!error && phase === 'idle' && (
            <motion.div
              key="hint"
              className="t-hint-wrap"
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduce ? undefined : { opacity: 0 }}
            >
              <p className="t-hint">{idleHint}</p>
              {(mtProgress !== null || sttProgress !== null) && (
                <div className="t-bar" role="progressbar">
                  <motion.div
                    className="t-bar-fill"
                    animate={{ width: `${Math.round(sttProgress ?? mtProgress ?? 0)}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="t-modes">
        <fieldset className="t-mode-group">
          <legend>Input</legend>
          {(['voice', 'text'] as InputMode[]).map((m) => (
            <button
              key={m}
              className={inputMode === m ? 'sel' : ''}
              onClick={() => setInputMode(m)}
              aria-pressed={inputMode === m}
            >
              {m === 'voice' ? '🎤 Speak' : '⌨️ Type'}
            </button>
          ))}
        </fieldset>
        <fieldset className="t-mode-group">
          <legend>Output</legend>
          {(['voice', 'text'] as OutputMode[]).map((m) => (
            <button
              key={m}
              className={outputMode === m ? 'sel' : ''}
              onClick={() => setOutputMode(m)}
              aria-pressed={outputMode === m}
            >
              {m === 'voice' ? '🔊 Speak' : '🔇 Text only'}
            </button>
          ))}
        </fieldset>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {inputMode === 'voice' ? (
          <motion.div
            key="voice-input"
            className="t-input"
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -12 }}
            transition={{ duration: 0.18 }}
          >
            <motion.button
              className={`t-mic ${phase === 'recording' ? 'rec' : ''}`}
              disabled={!sttReady}
              // Pointer capture keeps pointerup on this element even if the
              // finger slides off, which is what a held button needs. It also
              // removes the pointerleave hack that fired stop twice.
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                // Synchronously, inside the gesture — Android will not let us
                // speak later otherwise.
                tts.unlock();
                void startRecording();
              }}
              onPointerUp={() => void stopAndTranslate()}
              onPointerCancel={() => void stopAndTranslate()}
              whileTap={reduce ? undefined : { scale: 0.95 }}
              aria-label={phase === 'recording' ? 'Release to translate' : 'Hold to speak'}
            >
              {phase === 'recording' && !reduce && (
                <motion.span
                  className="t-mic-ring"
                  aria-hidden="true"
                  animate={{ scale: [1, 1.35], opacity: [0.55, 0] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: 'easeOut' }}
                />
              )}
              <MicIcon active={phase === 'recording'} />
            </motion.button>
            <p className={`t-mic-label ${nearLimit ? 'warn' : ''}`}>
              {!sttReady
                ? sttProgress !== null
                  ? `Speech model ${Math.round(sttProgress)}%`
                  : 'Preparing speech…'
                : phase === 'recording'
                ? `${recSeconds}s — release to translate`
                : 'Hold to speak'}
            </p>
          </motion.div>
        ) : (
          <motion.div
            key="text-input"
            className="t-input"
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -12 }}
            transition={{ duration: 0.18 }}
          >
            <textarea
              className="t-textarea"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={from === 'en' ? 'Type in English…' : 'Введите текст…'}
              lang={from}
              rows={3}
            />
            <motion.button
              className="t-translate"
              disabled={!mtReady || typed.trim() === ''}
              onClick={() => {
                tts.unlock();
                void translateText(typed);
              }}
              whileTap={reduce ? undefined : { scale: 0.97 }}
            >
              {mtReady ? 'Translate' : 'Loading translation…'}
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      <footer className="t-footer">
        <span className="t-footer-label">Speech model</span>
        <div className="t-footer-models">
          {(['tiny', 'base'] as WhisperVariant[]).map((v) => (
            <button
              key={v}
              className={activeVariant === v ? 'sel' : ''}
              onClick={() => {
                if (activeVariant === v) return;
                setSttVariant(v);
                // The old model is already in memory; a reload is the simplest
                // honest way to swap it. Downloaded files stay in IndexedDB.
                location.reload();
              }}
            >
              {v}
              {v === 'tiny' ? ' · 39 MB' : ' · 73 MB'}
            </button>
          ))}
        </div>
        <p className="t-footer-note">
          {activeVariant === 'tiny'
            ? 'Tiny is fast but weak at Russian — it often returns only a word or two. Use base if Russian matters.'
            : 'Base is markedly better at Russian than tiny, and slower.'}
          {sttReady ? ` Running on ${whisper.activeDevice}/${whisper.activeDtype}.` : ''}
        </p>
      </footer>
    </div>
  );
}

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg
      className="t-mic-svg"
      viewBox="0 0 24 24"
      width="42"
      height="42"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" fill={active ? 'currentColor' : 'none'} />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  );
}
