import type { CatalogAgentId } from '@/backends/types';
import type { CloudConnectTargetStatus, CloudVendorKey } from '@happier-dev/agents';
import type { ConnectedServiceId } from '@happier-dev/protocol';

export type { CloudConnectTargetStatus, CloudVendorKey };

export type ConnectedAccountVendorKey = CloudVendorKey | 'github';

export type ConnectTargetId = CatalogAgentId | 'github';

export type CloudConnectResult = Readonly<{
  vendorKey: ConnectedAccountVendorKey;
  oauth: unknown;
}>;

export type CloudConnectAuthenticateOptions = Readonly<{
  paste?: boolean;
  device?: boolean;
  noOpen?: boolean;
  timeoutSeconds?: number;
}>;

export type CloudConnectTarget = Readonly<{
  id: ConnectTargetId;
  aliases?: readonly string[];
  displayName: string;
  vendorDisplayName: string;
  vendorKey: ConnectedAccountVendorKey;
  /**
   * Whether this connect target is actively consumed by Happy (CLI/app) today.
   *
   * - wired: connecting has an effect (token is fetched/used by the product)
   * - experimental: token may be stored but not yet used everywhere
   */
  status: CloudConnectTargetStatus;
  authenticate: (opts?: CloudConnectAuthenticateOptions) => Promise<unknown>;
  importServiceId?: ConnectedServiceId;
  importSources?: readonly Readonly<{ id: string; label: string }>[];
  importCredentials?: (opts: Readonly<{ source: string; signal?: AbortSignal }>) => Promise<unknown>;
  postConnect?: (oauth: unknown) => void;
}>;
