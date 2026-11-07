import type { ConnectedServiceQuotaFetcher, ConnectedServiceQuotaFetcherDescriptor, ConnectedServiceSubscriptionFetcher } from './types';

import { getConnectedServiceQuotaFetcherDescriptors } from '@/backends/catalog';
import { readConnectedServiceQuotaStaleAfterMs } from './configuration';

export function createConnectedServiceQuotaFetchers(
  env: NodeJS.ProcessEnv,
  descriptors: ReadonlyArray<ConnectedServiceQuotaFetcherDescriptor> = getConnectedServiceQuotaFetcherDescriptors(),
): Array<ConnectedServiceQuotaFetcher> {
  return createConnectedServiceAccountFetchers(env, descriptors).quotaFetchers;
}

export function createConnectedServiceAccountFetchers(
  env: NodeJS.ProcessEnv,
  descriptors: ReadonlyArray<ConnectedServiceQuotaFetcherDescriptor> = getConnectedServiceQuotaFetcherDescriptors(),
): Readonly<{ quotaFetchers: ConnectedServiceQuotaFetcher[]; subscriptionFetchers: ConnectedServiceSubscriptionFetcher[] }> {
  const staleAfterMs = readConnectedServiceQuotaStaleAfterMs(env);

  const quotaFetchers: ConnectedServiceQuotaFetcher[] = [];
  const subscriptionFetchers: ConnectedServiceSubscriptionFetcher[] = [];
  for (const descriptor of descriptors) {
    const host = { env, staleAfterMs };
    const quota = descriptor.loadQuota?.(host);
    const subscription = descriptor.loadSubscription?.(host);
    if (quota) quotaFetchers.push(quota);
    if (subscription) subscriptionFetchers.push(subscription);
  }
  return { quotaFetchers, subscriptionFetchers };
}
