import type { ConnectedServiceStateSharingDescriptor } from '@/backends/types';

export const agyConnectedServiceStateSharingDescriptor = {
  providerId: 'agy',
  providerSupportStatus: 'supported',
  config: {
    supported: true,
    modes: ['linked', 'copied', 'isolated'],
    entries: [
      { path: 'config/skills', mode: 'linked_or_copied' },
      { path: 'antigravity-cli/skills', mode: 'linked_or_copied' },
      { path: 'config/hooks.json', mode: 'linked_or_copied' },
      { path: 'config/mcp_config.json', mode: 'linked_or_copied' },
      { path: 'antigravity-acp/trusted_workspaces.json', mode: 'copied' },
    ],
  },
  state: {
    supported: true,
    modes: ['isolated', 'shared'],
    entries: [
      { path: 'antigravity-acp/conversations', mode: 'linked' },
      { path: 'antigravity-acp/brain', mode: 'linked' },
    ],
    sharedStatePrivacyRiskAcknowledgementRequired: true,
    symlinkUnavailableDegradePolicy: 'block_continuity',
  },
  authIsolation: {
    mode: 'materialized_home',
    secretEntries: ['antigravity-acp/acp_token.json', 'antigravity-acp/acp_business_token.json', 'antigravity-acp/settings.json'],
  },
} satisfies ConnectedServiceStateSharingDescriptor;
