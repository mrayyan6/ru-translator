import { Platform } from 'react-native';
import * as Device from 'expo-device';
import { Paths } from 'expo-file-system';
import type { DeviceInfo } from '@core/types';

export function collectDeviceInfo(appVersion: string): DeviceInfo {
  let freeStorageBytes: number | null = null;
  let totalStorageBytes: number | null = null;
  try {
    freeStorageBytes = Paths.availableDiskSpace;
    totalStorageBytes = Paths.totalDiskSpace;
  } catch {
    // Some OS versions refuse this; a missing figure is better than a wrong one.
  }

  return {
    platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'other',
    osVersion: String(Device.osVersion ?? Platform.Version),
    modelName: Device.modelName ?? 'unknown',
    brand: Device.brand ?? null,
    totalMemoryBytes: Device.totalMemory ?? null,
    supportedCpuArchitectures: Device.supportedCpuArchitectures ?? null,
    freeStorageBytes,
    totalStorageBytes,
    isDevice: Device.isDevice,
    appVersion,
  };
}

export function formatBytes(b: number | null | undefined): string {
  if (b === null || b === undefined) return 'unknown';
  if (b > 1024 ** 3) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  if (b > 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}

/**
 * Peak memory is the measurement that matters most and the one we cannot take
 * from JavaScript. iOS jetsam kills are silent — the app simply vanishes — so
 * knowing how close we run to the limit is worth more than any latency figure.
 *
 * Getting it needs a small native module reading `task_vm_info.phys_footprint`
 * on iOS and `Debug.MemoryInfo` on Android. That is a Phase 1 task; for now we
 * report the shortfall honestly rather than substituting total RAM and calling
 * it a measurement.
 */
export function peakMemoryNote(): string {
  return Platform.select({
    ios: 'Peak memory not measured — needs a native module reading task_vm_info.phys_footprint (Phase 1).',
    android: 'Peak memory not measured — needs a native module reading Debug.MemoryInfo (Phase 1).',
    default: 'Peak memory not measured.',
  })!;
}
