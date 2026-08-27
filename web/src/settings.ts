import type { WhisperVariant } from '@core/types';
import { DEFAULT_STT_DEVICE, type SttDevice } from './engines/stt';

const DEVICE_KEY = 'ru-stt-device';
const VARIANT_KEY = 'ru-stt-variant';
const WARMUP_KEY = 'ru-stt-warmup';

/**
 * Engine choices live in localStorage rather than React state so the translator
 * and the diagnostics screen agree without either owning the other, and so a
 * setting survives the tab being killed — which on this project happens often
 * enough to matter.
 */
export function getSttDevice(): SttDevice {
  try {
    const v = localStorage.getItem(DEVICE_KEY);
    return v === 'webgpu' || v === 'wasm' ? v : DEFAULT_STT_DEVICE;
  } catch {
    return DEFAULT_STT_DEVICE;
  }
}

export function setSttDevice(device: SttDevice) {
  try {
    localStorage.setItem(DEVICE_KEY, device);
  } catch {
    /* private mode */
  }
}

export function getSttVariant(): WhisperVariant {
  try {
    const v = localStorage.getItem(VARIANT_KEY);
    return v === 'tiny' || v === 'base' || v === 'small' ? v : 'base';
  } catch {
    return 'base';
  }
}

export function setSttVariant(variant: WhisperVariant) {
  try {
    localStorage.setItem(VARIANT_KEY, variant);
  } catch {
    /* private mode */
  }
}

/** Last measured warm-up duration, shown so a slow first run is explicable. */
export function getLastWarmUpMs(): number | null {
  try {
    const v = localStorage.getItem(WARMUP_KEY);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

export function setLastWarmUpMs(ms: number) {
  try {
    localStorage.setItem(WARMUP_KEY, String(Math.round(ms)));
  } catch {
    /* private mode */
  }
}
