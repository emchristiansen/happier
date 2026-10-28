import React from 'react';

import type { LocalSettings } from '../domains/settings/localSettings';
import type { Settings } from '../domains/settings/settings';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { SettingsAnalyticsSource } from '@/track/settingsAnalytics/types';
import { getStorage } from '@/sync/domains/state/storageStore';

export function applyLocalSettingsFromUi(delta: Partial<LocalSettings>): void {
  getStorage().getState().applyLocalSettings(delta, { source: 'ui' satisfies SettingsAnalyticsSource });
}

export function useApplySettings(): (delta: Partial<Settings>) => void {
  return React.useCallback((delta: Partial<Settings>) => {
    getSyncSingleton().applySettings(delta, { source: 'ui' satisfies SettingsAnalyticsSource });
  }, []);
}

export function applySystemSettings(delta: Partial<Settings>): void {
  getSyncSingleton().applySettings(delta, { source: 'system' satisfies SettingsAnalyticsSource });
}

export function useApplyLocalSettings(): (delta: Partial<LocalSettings>) => void {
  return React.useCallback((delta: Partial<LocalSettings>) => {
    applyLocalSettingsFromUi(delta);
  }, []);
}
