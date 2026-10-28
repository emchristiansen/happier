import type { CloudConnectTarget } from '@/cloud/connectTypes';
import { AGENTS_CORE } from '@happier-dev/agents';
import { authenticateClaudeSubscriptionOauth } from './authenticateClaudeSubscriptionOauth';
import { importClaudeNativeCredentials } from './importClaudeNativeCredentials';

export const claudeCloudConnect: CloudConnectTarget = {
  id: 'claude',
  displayName: 'Claude',
  vendorDisplayName: 'Anthropic Claude',
  vendorKey: AGENTS_CORE.claude.cloudConnect!.vendorKey,
  status: AGENTS_CORE.claude.cloudConnect!.status,
  authenticate: (opts) => authenticateClaudeSubscriptionOauth(opts),
  importServiceId: 'claude-subscription',
  importSources: [{ id: 'native', label: 'Claude native login' }],
  importCredentials: importClaudeNativeCredentials,
};
