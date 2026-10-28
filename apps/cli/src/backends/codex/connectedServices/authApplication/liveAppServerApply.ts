import { requireConnectedServiceOauthCredentialRecord } from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';

import {
  evaluateCodexConnectedServiceHotApplyEligibility,
  readCodexCredentialProviderAccountId,
} from './eligibility';
import type {
  CodexDirectLiveAuthApplyInput,
  CodexDirectLiveAuthApplyResult,
  CodexRefreshSelectionRollback,
} from './types';

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const record = error as Record<string, unknown>;
    return [record.message, record.error, record.code, record.reason]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
  }
  return '';
}

function readErrorCode(error: unknown): number | string | null {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'number' || typeof code === 'string' ? code : null;
}

function classifyCodexLoginStartError(error: unknown): CodexDirectLiveAuthApplyResult {
  const message = readErrorMessage(error).toLowerCase();
  const code = readErrorCode(error);
  if (
    code === -32601
    || message.includes('method not found')
    || (message.includes('chatgptauthtokens') && (message.includes('unknown') || message.includes('unsupported')))
    || (message.includes('experimental') && message.includes('api'))
  ) {
    return { applied: false, reason: 'experimental_api_unavailable' };
  }
  if (
    message.includes('forced_chatgpt_workspace_id')
    || message.includes('workspace')
    || message.includes('chatgptaccountid')
  ) {
    return { applied: false, reason: 'forced_workspace_incompatible' };
  }
  if (message.includes('forced_login_method') || message.includes('login method')) {
    return {
      applied: false,
      reason: 'direct_live_hot_auth_ineligible',
      detailReason: 'credential_family_mismatch',
    };
  }
  return { applied: false, reason: 'live_hot_auth_failed' };
}

export async function applyCodexAppServerChatGptAuthTokens(params: Readonly<{
  client: CodexDirectLiveAuthApplyInput['client'];
  accessToken: string;
  chatgptAccountId: string;
}>): Promise<void> {
  await params.client.request('account/login/start', {
    type: 'chatgptAuthTokens',
    accessToken: params.accessToken,
    chatgptAccountId: params.chatgptAccountId,
  });
}

export async function applyCodexDirectLiveAppServerAuth(
  params: CodexDirectLiveAuthApplyInput,
): Promise<CodexDirectLiveAuthApplyResult> {
  const eligibility = evaluateCodexConnectedServiceHotApplyEligibility({
    candidate: params.candidate,
    forcedWorkspaceId: params.forcedWorkspaceId,
    forcedLoginMethod: params.forcedLoginMethod,
  });
  if (!eligibility.eligible) {
    return {
      applied: false,
      reason: eligibility.reason,
      ...('detailReason' in eligibility ? { detailReason: eligibility.detailReason } : {}),
    };
  }

  const accountId = readCodexCredentialProviderAccountId(params.candidate);
  if (!accountId) {
    return {
      applied: false,
      reason: 'direct_live_hot_auth_ineligible',
      detailReason: 'provider_account_identity_unavailable',
    };
  }

  if (params.refreshSelection && typeof params.updateRefreshSelection !== 'function') {
    return { applied: false, reason: 'refresh_selection_resync_failed' };
  }

  let rollbackRefreshSelection: CodexRefreshSelectionRollback | null = null;
  if (params.refreshSelection) {
    try {
      const rollback = await params.updateRefreshSelection?.(params.refreshSelection);
      rollbackRefreshSelection = typeof rollback === 'function' ? rollback : null;
    } catch {
      return { applied: false, reason: 'refresh_selection_resync_failed' };
    }
  }

  const record = requireConnectedServiceOauthCredentialRecord(params.candidate);
  try {
    await applyCodexAppServerChatGptAuthTokens({
      client: params.client,
      accessToken: record.oauth.accessToken,
      chatgptAccountId: accountId,
    });
  } catch (error) {
    if (params.refreshSelection) {
      if (!rollbackRefreshSelection) {
        return { applied: false, reason: 'refresh_selection_resync_failed' };
      }
      try {
        await rollbackRefreshSelection();
      } catch {
        return { applied: false, reason: 'refresh_selection_resync_failed' };
      }
    }
    return classifyCodexLoginStartError(error);
  }

  if (typeof params.persistAuthStore !== 'function') {
    return {
      applied: true,
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: accountId,
      durability: {
        persisted: false,
        errorCode: 'auth_store_persistence_unavailable_after_live_apply',
      },
    };
  }

  try {
    await params.persistAuthStore();
  } catch {
    return {
      applied: true,
      appliedVia: 'direct_live_hot_auth',
      activeAccountId: accountId,
      durability: {
        persisted: false,
        errorCode: 'auth_store_persistence_failed_after_live_apply',
      },
    };
  }

  return {
    applied: true,
    appliedVia: 'direct_live_hot_auth',
    activeAccountId: accountId,
    durability: { persisted: true },
  };
}
