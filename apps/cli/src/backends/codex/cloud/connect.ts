import type { CloudConnectTarget } from '@/cloud/connectTypes';
import { AGENTS_CORE } from '@happier-dev/agents';
import { authenticateCodex } from './authenticate';
import { readCodexNativeAuthCredentials } from '../cli/auth/readCodexEnvironmentAuthState';
import { ConnectedServiceImportError } from '@/cloud/connectedServices/connectedServiceImportError';
import type { CodexAuthTokens } from './oauthExchange';

export const codexCloudConnect: CloudConnectTarget = {
  id: 'codex',
  displayName: 'Codex',
  vendorDisplayName: 'OpenAI Codex',
  vendorKey: AGENTS_CORE.codex.cloudConnect!.vendorKey,
  status: AGENTS_CORE.codex.cloudConnect!.status,
  authenticate: (opts) => authenticateCodex(opts),
  importServiceId: 'openai-codex',
  importSources: [{ id: 'native', label: 'Codex native login' }],
  importCredentials: async ({ source, signal }): Promise<CodexAuthTokens> => {
    if (source !== 'native') {
      throw new ConnectedServiceImportError('unsupported_source', 'Unsupported Codex import source');
    }
    const tokens = await readCodexNativeAuthCredentials({ signal });
    return {
      id_token: tokens.idToken, access_token: tokens.accessToken, refresh_token: tokens.refreshToken,
      account_id: tokens.accountId, expires_at: tokens.expiresAt,
    };
  },
};
