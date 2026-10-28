import { resolveHomeDirFromEnvironment } from '@happier-dev/cli-common/providers';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { ConnectedServiceImportError } from '@/cloud/connectedServices/connectedServiceImportError';
import { readClaudeCodeNativeCredential } from '../connectedServices/nativeAuth/claudeCodeCredentialFile';
import { classifyClaudeCodeCredentialHealth } from '../connectedServices/nativeAuth/claudeCodeCredentialHealth';
import { resolveConfiguredClaudeConfigDir } from '../utils/resolveConfiguredClaudeConfigDir';
import type { ClaudeSubscriptionOauthTokens } from './authenticateClaudeSubscriptionOauth';

export async function importClaudeNativeCredentials(params: Readonly<{
  source: string;
  signal?: AbortSignal;
}>): Promise<ClaudeSubscriptionOauthTokens & Readonly<{
  claudeAiOauth: Readonly<{ subscriptionType?: string; rateLimitTier?: string }>;
}>> {
  params.signal?.throwIfAborted();
  if (params.source !== 'native') {
    throw new ConnectedServiceImportError('unsupported_source', 'This Claude credential source is not supported.');
  }
  const native = await readClaudeCodeNativeCredential({
    claudeConfigDir: resolveConfiguredClaudeConfigDir({ env: process.env }),
    homeDir: resolveHomeDirFromEnvironment(process.env),
    signal: params.signal,
  });
  params.signal?.throwIfAborted();
  if (!native) {
    throw new ConnectedServiceImportError('credentials_unavailable', 'No supported Claude native login was found on this machine.');
  }
  const credential = native.payload.claudeAiOauth;
  const now = Date.now();
  if (!credential.refreshToken || typeof credential.expiresAt !== 'number' || credential.expiresAt <= now) {
    throw new ConnectedServiceImportError('reauthorization_required', 'Sign in to Claude again before importing this native login.');
  }
  const scope = credential.scopes.join(' ');
  const record = buildConnectedServiceCredentialRecord({
    now, serviceId: 'claude-subscription', profileId: 'native-import', kind: 'oauth',
    expiresAt: credential.expiresAt ?? null,
    oauth: {
      accessToken: credential.accessToken, refreshToken: credential.refreshToken,
      idToken: null, tokenType: 'Bearer', scope, providerAccountId: null, providerEmail: null,
    },
  });
  if (classifyClaudeCodeCredentialHealth(record).status !== 'ok') {
    throw new ConnectedServiceImportError('reauthorization_required', 'Sign in to Claude again before importing this native login.');
  }
  // Preserve the rotating native grant: importing a valid login does not refresh or rewrite it.
  // Native root-config identity is separate from this credential and cannot prove its account.
  return {
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    expires_in: (credential.expiresAt - now) / 1000,
    token_type: 'Bearer',
    scope,
    claudeAiOauth: {
      ...(credential.subscriptionType ? { subscriptionType: credential.subscriptionType } : {}),
      ...(credential.rateLimitTier ? { rateLimitTier: credential.rateLimitTier } : {}),
    },
  };
}
