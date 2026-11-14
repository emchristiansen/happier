import { describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

import { createDaemonControlApp } from './controlServer';
import { TURN_COMPLETION_CONTRACT_HEADER } from './connectedServices/connectedServiceTurnLifecycleContract';

function app(handleConnectedServiceTurnLifecycle: Parameters<typeof createDaemonControlApp>[0]['handleConnectedServiceTurnLifecycle']) {
  return createDaemonControlApp({
    getChildren: () => [],
    machineId: 'machine',
    stopSession: async () => ({ status: 'not_found' as const }),
    spawnSession: async () => ({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'unused' }),
    requestShutdown: () => {},
    onHappySessionWebhook: () => {},
    controlToken: 'token',
    handleConnectedServiceTurnLifecycle,
  });
}

describe('turn lifecycle completion contract header', () => {
  it.each([
    ['a declared contract', 'claude_sdk_result_bound_v1', { turnCompletionContract: 'claude_sdk_result_bound_v1' }],
    ['an unknown contract value', 'claude_sdk_result_bound_v9', {}],
    ['no header', undefined, {}],
  ] as const)('forwards %s exactly, never inventing one', async (_label, header, expected) => {
    const handler = vi.fn(async () => ({ status: 'input_blocked' as const, reason: 'request_auth_source_cutover' as const }));
    const server = app(handler);
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/connected-service-turn-lifecycle',
        headers: { 'x-happier-daemon-token': 'token', ...(header ? { [TURN_COMPLETION_CONTRACT_HEADER]: header } : {}) },
        // The body stays strict and unchanged, so an older daemon simply ignores the header.
        payload: { sessionId: 's', event: 'assistant_message_end', terminalStatus: 'completed', turnId: 't' },
      });
      expect(response.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledWith({
        sessionId: 's', event: 'assistant_message_end', terminalStatus: 'completed', turnId: 't', ...expected,
      });
    } finally {
      await server.close();
    }
  });
});
