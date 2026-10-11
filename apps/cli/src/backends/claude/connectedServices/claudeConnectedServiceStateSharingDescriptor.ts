import type { ConnectedServiceStateSharingDescriptor } from '@/backends/types';

export const claudeConnectedServiceStateSharingDescriptor = {
  providerId: 'claude',
  providerSupportStatus: 'supported',
  config: {
    supported: true,
    modes: ['linked', 'copied', 'isolated'],
    entries: [
      { path: 'settings.json', mode: 'linked_or_copied' },
      { path: 'settings.local.json', mode: 'linked_or_copied' },
      { path: 'agents', mode: 'linked_or_copied' },
      { path: 'commands', mode: 'linked_or_copied' },
      { path: 'hooks', mode: 'linked_or_copied' },
      { path: 'plugins', mode: 'linked_or_copied' },
      { path: 'rules', mode: 'linked_or_copied' },
      { path: 'skills', mode: 'linked_or_copied' },
      // Global user memory. Always a link, even when config is copied: Claude Code dedupes it against the
      // walk-up project memory by file identity, so a copy would be delivered twice for sessions under HOME.
      { path: 'CLAUDE.md', mode: 'linked' },
    ],
  },
  state: {
    supported: true,
    modes: ['isolated', 'shared'],
    entries: [
      { path: 'projects', mode: 'linked' },
    ],
    sharedStatePrivacyRiskAcknowledgementRequired: true,
    symlinkUnavailableDegradePolicy: 'block_continuity',
  },
  authIsolation: {
    mode: 'materialized_home',
    secretEntries: [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_SETUP_TOKEN',
      'CLAUDE_API_KEY',
      'ANTHROPIC_API_KEY',
      '.claude.json',
      '.credentials.json',
      'credentials.json',
      'auth.json',
      'accounts',
    ],
  },
} satisfies ConnectedServiceStateSharingDescriptor;
