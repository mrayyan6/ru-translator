import type { DeviceInfo } from '@core/types';
import { getStorageStatus } from './storage';

function detectPlatform(): DeviceInfo['platform'] {
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac, so the touch-point check is what catches it.
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (iOS) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'other';
}

function detectOsVersion(): string {
  const ua = navigator.userAgent;
  const ios = ua.match(/OS (\d+[_.]\d+(?:[_.]\d+)?)/);
  if (ios) return ios[1].replace(/_/g, '.');
  const android = ua.match(/Android (\d+(?:\.\d+)*)/);
  if (android) return android[1];
  return 'unknown';
}

function detectBrowser(): string {
  const ua = navigator.userAgent;
  // Order matters: Chrome's UA contains "Safari", and on iOS every browser is
  // WebKit underneath regardless of what it calls itself.
  if (/CriOS/.test(ua)) return 'Chrome (iOS/WebKit)';
  if (/FxiOS/.test(ua)) return 'Firefox (iOS/WebKit)';
  if (/EdgiOS/.test(ua)) return 'Edge (iOS/WebKit)';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'unknown';
}

export interface WebDeviceInfo extends DeviceInfo {
  browser: string;
  userAgent: string;
  hardwareConcurrency: number | null;
  /** Chrome only, and coarsely rounded. Absent on Safari. */
  deviceMemoryGb: number | null;
  standalone: boolean;
  crossOriginIsolated: boolean;
}

export async function collectWebDeviceInfo(appVersion: string): Promise<WebDeviceInfo> {
  const storage = await getStorageStatus();
  const deviceMemoryGb = (navigator as any).deviceMemory ?? null;

  return {
    platform: detectPlatform(),
    osVersion: detectOsVersion(),
    // The browser will not tell us the phone model, and guessing from the user
    // agent produces confident nonsense. Report what we actually know.
    modelName: 'not exposed to the browser',
    brand: null,
    totalMemoryBytes: deviceMemoryGb ? deviceMemoryGb * 1024 ** 3 : null,
    supportedCpuArchitectures: null,
    freeStorageBytes:
      storage.quotaBytes !== null && storage.usageBytes !== null
        ? storage.quotaBytes - storage.usageBytes
        : null,
    totalStorageBytes: storage.quotaBytes,
    isDevice: true,
    appVersion,
    browser: detectBrowser(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGb,
    standalone: storage.standalone,
    crossOriginIsolated: storage.crossOriginIsolated,
  };
}
