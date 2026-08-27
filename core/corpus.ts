import type { Lang } from './types';

export interface Utterance {
  id: string;
  lang: Lang;
  /** What the tester should say out loud, verbatim. */
  say: string;
  /** Reference translation, used only as a human sanity anchor — not an automated assertion. */
  reference: string;
  /** Why this sentence is in the set. */
  why: string;
}

/**
 * Five per direction, as specified. Chosen so failures are diagnostic rather than
 * merely disappointing: each one stresses something different.
 *
 * Russian → English is the critical direction. These are sentences a Russian
 * speaker would actually say back to a lost tourist, not textbook phrases.
 */
export const EN_UTTERANCES: Utterance[] = [
  {
    id: 'en-1',
    lang: 'en',
    say: 'Where is the nearest train station?',
    reference: 'Где ближайший вокзал?',
    why: 'The canonical case. If this fails, nothing else matters.',
  },
  {
    id: 'en-2',
    lang: 'en',
    say: 'My daughter has a peanut allergy. Does this dish contain nuts?',
    reference: 'У моей дочери аллергия на арахис. В этом блюде есть орехи?',
    why: 'Two clauses, and a wrong answer has real consequences. Tests length and stakes.',
  },
  {
    id: 'en-3',
    lang: 'en',
    say: 'How much does a ticket to Saint Petersburg cost?',
    reference: 'Сколько стоит билет до Санкт-Петербурга?',
    why: 'Proper noun that Whisper must not mangle, plus a number-answer question.',
  },
  {
    id: 'en-4',
    lang: 'en',
    say: 'We booked a room for three nights under the name Miller.',
    reference: 'Мы забронировали номер на три ночи на имя Миллер.',
    why: 'A surname. Transliteration of names is a common, visible failure.',
  },
  {
    id: 'en-5',
    lang: 'en',
    say: 'Excuse me, I think I left my bag on the train.',
    reference: 'Извините, кажется, я оставил свою сумку в поезде.',
    why: 'Hedged, conversational register — not the clean imperative style models are best at.',
  },
];

export const RU_UTTERANCES: Utterance[] = [
  {
    id: 'ru-1',
    lang: 'ru',
    say: 'Где находится ближайшая аптека?',
    reference: 'Where is the nearest pharmacy?',
    why: 'The mirror of en-1. Baseline for the critical direction.',
  },
  {
    id: 'ru-2',
    lang: 'ru',
    say: 'Поезд отправляется с четвёртой платформы через двадцать минут.',
    reference: 'The train departs from platform four in twenty minutes.',
    why: 'Exactly what an announcement sounds like. Numbers and platform references must survive.',
  },
  {
    id: 'ru-3',
    lang: 'ru',
    say: 'Извините, здесь нельзя фотографировать.',
    reference: 'Sorry, photography is not allowed here.',
    why: 'A negation. Dropping "нельзя" inverts the meaning — a silent, high-cost error.',
  },
  {
    id: 'ru-4',
    lang: 'ru',
    say: 'Вам нужно пересесть на кольцевую линию на следующей станции.',
    reference: 'You need to change to the circle line at the next station.',
    why: 'Metro directions: the single most likely thing the family will need to understand.',
  },
  {
    id: 'ru-5',
    lang: 'ru',
    say: 'У вас есть что-нибудь без мяса?',
    reference: 'Do you have anything without meat?',
    why: 'Colloquial "что-нибудь", and another negation-sensitive sentence.',
  },
];

export const ALL_UTTERANCES = [...EN_UTTERANCES, ...RU_UTTERANCES];

/**
 * Short, unambiguous strings for the TTS-only test. Kept separate from the STT
 * corpus so a TTS failure can't be confused with a recognition failure.
 */
export const TTS_PROBES: Record<Lang, string> = {
  en: 'Where is the nearest pharmacy?',
  ru: 'Где находится ближайшая аптека?',
};
