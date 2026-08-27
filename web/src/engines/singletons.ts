import { WebPcmRecorder } from '../audio';
import { WebTranslationEngine } from './mt';
import { OnDeviceWebSpeechRecognizer, WhisperWebRecognizer } from './stt';
import { WebSpeechSynthesizer } from './tts';

/**
 * One instance of each engine for the whole app.
 *
 * Models are expensive to load and expensive in memory — a second copy of
 * Whisper would roughly double the footprint, which on a phone is the
 * difference between working and having the tab killed. Both the translator
 * screen and the diagnostics harness share these.
 */
export const recorder = new WebPcmRecorder();
export const whisper = new WhisperWebRecognizer();
export const webSpeech = new OnDeviceWebSpeechRecognizer();
export const mt = new WebTranslationEngine();
export const tts = new WebSpeechSynthesizer();
