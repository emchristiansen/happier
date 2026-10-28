import { describe, expect, it } from 'vitest';

import { createProviderEnforcedPermissionHandler } from './createProviderEnforcedPermissionHandler';

class FakeRpcHandlerManager {
  handlers = new Map<string, (payload: any) => any>();
  registerHandler(name: string, handler: any) {
    this.handlers.set(name, handler);
  }
}

class FakeSession {
  rpcHandlerManager = new FakeRpcHandlerManager();
  agentState: any = { requests: {}, completedRequests: {} };

  getAgentStateSnapshot() {
    return this.agentState;
  }

  async updateAgentStateRequestSettlement(updater: Parameters<FakeSession['updateAgentState']>[0]): Promise<void> {

    await this.updateAgentState(updater);

  }


  updateAgentState(updater: any) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }
}

describe('createProviderEnforcedPermissionHandler', () => {
  it('creates a provider-enforced handler with optional safe-tool extensions', async () => {
    const session = new FakeSession();
    const handler = createProviderEnforcedPermissionHandler({
      session: session as any,
      logPrefix: '[TestProvider]',
      alwaysAutoApproveToolNameIncludes: ['geminireasoning'],
    });

    await expect(handler.handleToolCall('safe-extension', 'geminireasoning', {}))
      .resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-1', 'think', {})).resolves.toEqual({ decision: 'approved' });

    const pending = handler.handleToolCall('pending-1', 'Edit', {});
    expect(session.agentState.requests['pending-1']).toBeTruthy();
    const respond = session.rpcHandlerManager.handlers.get('permission');
    if (!respond) throw new Error('Permission RPC was not registered');
    await respond({ id: 'pending-1', approved: false, decision: 'denied' });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });
});
