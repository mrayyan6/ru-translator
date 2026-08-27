import type { Lang, SttOutcome } from './types';

/**
 * Whisper does not return empty on silence — it invents fluent text. These are the
 * well-known attractors it falls into, mostly scraped from subtitle training data.
 * Matching is done on a normalised form so punctuation and case don't let one through.
 *
 * This list is a backstop. The primary defences are the VAD gate and the confidence
 * thresholds below; a blocklist alone would be whack-a-mole.
 */
const BLOCKLIST: Record<Lang, string[]> = {
  en: [
    'thank you',
    'thanks for watching',
    'thank you for watching',
    'please subscribe',
    'you',
    'bye',
    'the end',
    'transcription by castingwords',
    'subtitles by the amara.org community',
  ],
  ru: [
    'продолжение следует',
    'субтитры сделал dimatorzok',
    'субтитры делал dimatorzok',
    'редактор субтитров а.синецкая',
    'корректор а.егорова',
    'спасибо за просмотр',
    'подписывайтесь на канал',
    'субтитры и перевод',
    'дальше будет',
    'спасибо',
  ],
};

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?;:"'`«»…—–\-()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tuned conservatively: we would rather ask the user to repeat than speak nonsense. */
export const THRESHOLDS = {
  /** Reject when whisper.cpp is this confident the clip had no speech. */
  maxNoSpeechProb: 0.6,
  /** Reject when mean token log-probability falls below this. */
  minAvgLogprob: -1.0,
  /** Reject clips with less than this much detected speech. */
  minSpeechMs: 400,
  /** A transcript shorter than this, from a clip longer than a second, is suspect. */
  minChars: 2,
};

export interface GateInput {
  text: string;
  avgLogprob: number | null;
  noSpeechProb: number | null;
  lang: Lang;
  speechMs: number | null;
}

export interface GateVerdict {
  rejected: boolean;
  reason?: string;
}

/**
 * The confidence gate. Returns rejected=true when the transcript should NOT be
 * translated or spoken. The caller shows "Didn't catch that" instead.
 */
export function gateTranscript(input: GateInput): GateVerdict {
  const text = (input.text ?? '').trim();

  if (text.length < THRESHOLDS.minChars) {
    return { rejected: true, reason: 'empty or near-empty transcript' };
  }

  if (input.speechMs !== null && input.speechMs < THRESHOLDS.minSpeechMs) {
    return {
      rejected: true,
      reason: `only ${Math.round(input.speechMs)}ms of speech detected (need ${THRESHOLDS.minSpeechMs}ms)`,
    };
  }

  if (input.noSpeechProb !== null && input.noSpeechProb > THRESHOLDS.maxNoSpeechProb) {
    return {
      rejected: true,
      reason: `no_speech_prob ${input.noSpeechProb.toFixed(2)} above ${THRESHOLDS.maxNoSpeechProb}`,
    };
  }

  if (input.avgLogprob !== null && input.avgLogprob < THRESHOLDS.minAvgLogprob) {
    return {
      rejected: true,
      reason: `avg_logprob ${input.avgLogprob.toFixed(2)} below ${THRESHOLDS.minAvgLogprob}`,
    };
  }

  const n = normalise(text);
  const hits = BLOCKLIST[input.lang].filter((phrase) => n === phrase || n.startsWith(phrase));
  if (hits.length > 0) {
    return { rejected: true, reason: `known hallucination: "${hits[0]}"` };
  }

  // A single token repeated many times is the other classic degenerate output.
  const words = n.split(' ');
  if (words.length >= 6) {
    const unique = new Set(words);
    if (unique.size <= 2) {
      return { rejected: true, reason: 'degenerate repetition' };
    }
  }

  return { rejected: false };
}

export function applyGate(outcome: SttOutcome, lang: Lang, speechMs: number | null): SttOutcome {
  const verdict = gateTranscript({
    text: outcome.text,
    avgLogprob: outcome.avgLogprob,
    noSpeechProb: outcome.noSpeechProb,
    lang,
    speechMs,
  });
  return { ...outcome, rejected: verdict.rejected, rejectReason: verdict.reason };
}
