import { supportsConnectedServiceOperation, type ConnectedServiceId } from '@happier-dev/protocol';

import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { ConnectedServiceApiError } from './connectedServiceApiError';

export async function assertConnectedServiceOperationSupported(serviceId: ConnectedServiceId): Promise<void> {
  // Released services remain usable without a new capability declaration.
  if (supportsConnectedServiceOperation(null, serviceId)) return;
  const features = await getReadyServerFeatures();
  if (!supportsConnectedServiceOperation(features, serviceId)) {
    throw new ConnectedServiceApiError({ code: 'connect_service_unsupported' });
  }
}
