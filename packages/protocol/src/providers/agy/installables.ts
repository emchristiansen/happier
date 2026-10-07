import type { CapabilityId } from '../../capabilities.js';

export const INSTALLABLE_KEYS = {
  AGY_ACP_SERVER: 'agy-acp-server',
} as const;

export type InstallableKey = typeof INSTALLABLE_KEYS[keyof typeof INSTALLABLE_KEYS];

export const AGY_ACP_SERVER_DEP_ID = 'dep.agy-acp-server' as const satisfies CapabilityId;
export const AGY_ACP_SERVER_VERSION = '1.1.1' as const;
