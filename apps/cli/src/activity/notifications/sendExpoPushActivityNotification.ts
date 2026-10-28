import type { ExpoPushNotificationChannelV1 } from '@happier-dev/protocol';

import type { ActivityNotificationEvent } from './activityNotificationEvent';
import { buildActivityNotificationContent } from './buildActivityNotificationContent';

export type ExpoPushActivityNotificationOptions = Readonly<{ suppressIfComputerFocused?: boolean }>;

export type ExpoPushActivityNotificationSender = Readonly<{
  sendToAllDevicesAsync: (title: string, body: string, data: Record<string, unknown>, options?: ExpoPushActivityNotificationOptions) => Promise<void>;
}>;

export async function sendExpoPushActivityNotificationAsync(params: Readonly<{
  channel: ExpoPushNotificationChannelV1;
  event: ActivityNotificationEvent;
  sender: ExpoPushActivityNotificationSender;
  suppressIfComputerFocused?: boolean;
}>): Promise<void> {
  const built = buildActivityNotificationContent(params.event, {
    readyIncludeMessageText: params.channel.readyIncludeMessageText !== false,
    requestIncludeMessageText: params.channel.requestIncludeMessageText !== false,
  });
  if (params.suppressIfComputerFocused === true) {
    await params.sender.sendToAllDevicesAsync(built.title, built.body, built.data, { suppressIfComputerFocused: true });
  } else {
    await params.sender.sendToAllDevicesAsync(built.title, built.body, built.data);
  }
}
