import { createCatalogDefinedAcpBackend, type CatalogDefinedAcpBackendOptions } from '@/agent/acp/catalog/createCatalogDefinedAcpBackend';
import { findConnectedServiceChildSelection } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

// ACP 1.3.0 lets these inherited values override the selected account's endpoint/project.
const ACCOUNT_ENDPOINT_OVERRIDES = ['AGY_ACP_CCPA_BASE_URL', 'AGY_ACP_CCPA_PROJECT'] as const;

export function createAgyAcpBackend(options: CatalogDefinedAcpBackendOptions) {
  // ACP 1.3.0 distinguishes failed token refresh/onboarding from generic missing authentication.
  options = { ...options, isAuthenticationSetupFailure: ({ code, data }) =>
    code === -32000 && data !== null && typeof data === 'object' && !Array.isArray(data)
      && 'reason' in data && data.reason === 'onboarding_failed' };
  if (!findConnectedServiceChildSelection({ ...process.env, ...options.env }, 'antigravity')) {
    return createCatalogDefinedAcpBackend('agy', options);
  }
  const env = Object.fromEntries(Object.entries(options.env ?? {}).filter(([key]) =>
    !ACCOUNT_ENDPOINT_OVERRIDES.some((override) => key.toUpperCase() === override)));
  return createCatalogDefinedAcpBackend('agy', { ...options, env, unsetEnv: [...options.unsetEnv ?? [], ...ACCOUNT_ENDPOINT_OVERRIDES] });
}
