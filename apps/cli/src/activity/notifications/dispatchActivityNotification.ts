import {
  resolveNotificationChannelsV1FromAccountSettings,
  type AccountSettings,
} from '@happier-dev/protocol';

import { logger } from '@/ui/logger';
import type { ActivityNotificationEvent } from './activityNotificationEvent';
import {
  sendExpoPushActivityNotificationAsync,
  type ExpoPushActivityNotificationSender,
} from './sendExpoPushActivityNotification';
import { sendWebhookActivityNotificationAsync } from './sendWebhookActivityNotification';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';

function isTopicEnabled(channel: {
  enabled: boolean;
  topics: {
    ready: boolean;
    permissionRequest: boolean;
    userActionRequest: boolean;
    connectedServiceAccountSwitch?: boolean;
    connectedServiceQuotaBlocked?: boolean;
    connectedServiceQuotaRecovered?: boolean;
  };
}, topic: ActivityNotificationEvent['topic']): boolean {
  if (channel.enabled !== true) return false;
  if (topic === 'ready') return channel.topics.ready === true;
  if (topic === 'permission_request') return channel.topics.permissionRequest === true;
  if (topic === 'user_action_request') return channel.topics.userActionRequest === true;
  if (topic === 'connected_service_account_switch') return channel.topics.connectedServiceAccountSwitch === true;
  if (topic === 'connected_service_credential_health') return channel.topics.connectedServiceAccountSwitch === true;
  if (topic === 'connected_service_quota_blocked') return channel.topics.connectedServiceQuotaBlocked === true;
  if (topic === 'connected_service_quota_recovered') return channel.topics.connectedServiceQuotaRecovered === true;
  return false;
}

const recentDispatchesByKey = new Map<string, number>();
const DEFAULT_NOTIFICATION_DEDUPE_WINDOW_MS = 60_000;
const DEFAULT_NOTIFICATION_DEDUPE_MAX_ENTRIES = 1_000;

function notificationDedupeKey(event: ActivityNotificationEvent): string | null {
  if (event.topic === 'connected_service_account_switch') {
    return [
      event.topic,
      event.sessionId,
      event.serviceId,
      event.groupId,
      event.fromProfileId ?? '',
      event.toProfileId ?? '',
      event.reason,
      event.limitCategory ?? '',
      event.providerLimitId ?? '',
    ].join('\0');
  }
  if (event.topic === 'connected_service_quota_blocked' || event.topic === 'connected_service_quota_recovered') {
    return [
      event.topic,
      event.serviceId,
      event.groupId ?? '',
      event.profileId ?? '',
      event.nativeAuth === true ? 'native' : '',
      event.sessionId,
      event.issueFingerprint,
    ].join('\0');
  }
  if (event.topic === 'connected_service_credential_health') {
    return [
      event.topic,
      event.sessionId,
      event.serviceId,
      event.profileId,
      event.status,
      event.reason ?? '',
      event.providerErrorCode ?? '',
    ].join('\0');
  }
  return null;
}

function normalizeDedupeMaxEntries(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_NOTIFICATION_DEDUPE_MAX_ENTRIES;
  return Math.max(0, Math.trunc(value));
}

function pruneNotificationDedupeEntries(input: Readonly<{
  nowMs: number;
  dedupeWindowMs: number;
  maxEntries: number;
}>): void {
  if (input.dedupeWindowMs <= 0 || input.maxEntries <= 0) {
    recentDispatchesByKey.clear();
    return;
  }

  for (const [key, dispatchedAtMs] of recentDispatchesByKey) {
    if (input.nowMs - dispatchedAtMs >= input.dedupeWindowMs) {
      recentDispatchesByKey.delete(key);
    }
  }

  while (recentDispatchesByKey.size > input.maxEntries) {
    const oldestKey = recentDispatchesByKey.keys().next().value;
    if (typeof oldestKey !== 'string') break;
    recentDispatchesByKey.delete(oldestKey);
  }
}

function isSuppressedDuplicate(input: Readonly<{
  event: ActivityNotificationEvent;
  nowMs: number;
  dedupeWindowMs: number;
  maxEntries: number;
}>): boolean {
  if (input.dedupeWindowMs <= 0) return false;
  pruneNotificationDedupeEntries(input);
  const key = notificationDedupeKey(input.event);
  if (!key) return false;
  const lastDispatchedAtMs = recentDispatchesByKey.get(key);
  if (typeof lastDispatchedAtMs === 'number' && input.nowMs - lastDispatchedAtMs < input.dedupeWindowMs) {
    recentDispatchesByKey.delete(key);
    recentDispatchesByKey.set(key, lastDispatchedAtMs);
    return true;
  }
  return false;
}

function recordDeliveredNotificationForDedupe(input: Readonly<{
  event: ActivityNotificationEvent;
  nowMs: number;
  dedupeWindowMs: number;
  maxEntries: number;
}>): void {
  if (input.dedupeWindowMs <= 0) return;
  pruneNotificationDedupeEntries(input);
  const key = notificationDedupeKey(input.event);
  if (!key) return;
  recentDispatchesByKey.delete(key);
  recentDispatchesByKey.set(key, input.nowMs);
  pruneNotificationDedupeEntries(input);
}

export async function dispatchActivityNotificationAsync(params: Readonly<{
  settings: AccountSettings | null | undefined;
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>;
  event: ActivityNotificationEvent;
  expoPushSender?: ExpoPushActivityNotificationSender | null;
  nowMs?: () => number;
  dedupeWindowMs?: number;
  dedupeMaxEntries?: number;
}>): Promise<Readonly<{ attemptedChannels: number; deliveredChannels: number; suppressedChannels: number }>> {
  const channels = resolveNotificationChannelsV1FromAccountSettings(params.settings ?? null);
  const nowMs = (params.nowMs ?? (() => Date.now()))();
  const dedupeWindowMs = params.dedupeWindowMs ?? DEFAULT_NOTIFICATION_DEDUPE_WINDOW_MS;
  const dedupeMaxEntries = normalizeDedupeMaxEntries(params.dedupeMaxEntries);
  const duplicateSuppressed = isSuppressedDuplicate({
    event: params.event,
    nowMs,
    dedupeWindowMs,
    maxEntries: dedupeMaxEntries,
  });
  let attemptedChannels = 0;
  let deliveredChannels = 0;
  const eligibleChannelCount = channels.filter((channel) => isTopicEnabled(channel, params.event.topic)).length;
  if (duplicateSuppressed && eligibleChannelCount > 0) {
    return {
      attemptedChannels: 0,
      deliveredChannels: 0,
      suppressedChannels: eligibleChannelCount,
    };
  }

  for (const channel of channels) {
    if (!isTopicEnabled(channel, params.event.topic)) continue;
    attemptedChannels += 1;
    try {
      if (channel.kind === 'expo_push') {
        if (!params.expoPushSender) continue;
        await sendExpoPushActivityNotificationAsync({
          channel,
          event: params.event,
          sender: params.expoPushSender,
          suppressIfComputerFocused: params.settings?.notificationsSettingsV1?.mutePhoneWhenComputerFocused === true
            && (params.event.topic === 'ready' || params.event.topic === 'permission_request' || params.event.topic === 'user_action_request'),
        });
        deliveredChannels += 1;
        continue;
      }

      await sendWebhookActivityNotificationAsync({
        channel,
        event: params.event,
        settingsSecretsReadKeys: params.settingsSecretsReadKeys,
        nowMs: () => nowMs,
      });
      deliveredChannels += 1;
    } catch (error) {
      logger.debug('[activityNotifications] Failed to dispatch outbound notification', serializeAxiosErrorForLog(error));
    }
  }

  if (deliveredChannels > 0) {
    recordDeliveredNotificationForDedupe({
      event: params.event,
      nowMs,
      dedupeWindowMs,
      maxEntries: dedupeMaxEntries,
    });
  }

  return {
    attemptedChannels,
    deliveredChannels,
    suppressedChannels: 0,
  };
}
