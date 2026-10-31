import { join } from 'node:path';

import type { ConnectedServiceCredentialStorageCleanup } from '@/daemon/connectedServices/credentials/lifecycleTypes';
import { removeConnectedServiceCredentialFiles } from '@/daemon/connectedServices/credentials/removeConnectedServiceCredentialFiles';
import { deleteClaudeCodeMacOsKeychainCredential } from './nativeAuth/claudeCodeMacOsKeychain';

export const CLAUDE_CREDENTIAL_HOME_ENTRIES = Object.freeze([
  '.claude.json', '.credentials.json', 'credentials.json', 'auth.json', 'accounts',
] as const);

export const claudeConnectedServiceCredentialStorageCleanup: ConnectedServiceCredentialStorageCleanup = {
  async deleteCredentialStorageForHomeRoot({ rootDir, kind }) {
    await removeConnectedServiceCredentialFiles(rootDir, CLAUDE_CREDENTIAL_HOME_ENTRIES.map((entry) => `claude-config/${entry}`));
    // A renamed legacy home does not identify the original path-hashed Keychain service.
    // In particular, never derive it from a possibly recreated group's current home.
    if (process.platform !== 'darwin' || kind === 'group_home_quarantine' || kind === 'retired_home') return;
    await deleteClaudeCodeMacOsKeychainCredential({
      claudeConfigDir: join(rootDir, 'claude-config'),
    });
  },
};
