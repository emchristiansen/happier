import { describe, expect, it } from 'vitest';

import type { EnhancedMode } from '../loop';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

describe('Claude PermissionHandler - Happier MCP session-control tools', () => {
  it('auto-allows title changes in default mode without creating a permission request', async () => {
    const { session, client } = createPermissionHandlerSessionStub('change-title-default-auto-approve');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const mode: EnhancedMode = { permissionMode: 'default' };
    const signal = new AbortController();

    const result = await handler.handleToolCall(
      'Set session title',
      { title: 'Renamed from Claude' },
      mode,
      { signal: signal.signal, toolUseId: 'toolu_change_title_default_1' },
    );

    expect(result).toMatchObject({ behavior: 'allow' });
    expect(client.agentState.requests['toolu_change_title_default_1']).toBeUndefined();
  });

  it('auto-allows recognized first-party Action transport calls in default mode', async () => {
    const { session, client } = createPermissionHandlerSessionStub('execution-run-default-permission-request');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const mode: EnhancedMode = { permissionMode: 'default' };
    const signal = new AbortController();

    const result = await handler.handleToolCall(
      'mcp__happier__execution_run_start',
      {
        intent: 'delegate',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read_only',
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        instructions: 'Reply exactly QA_CODEX_READY.',
      },
      mode,
      { signal: signal.signal, toolUseId: 'toolu_execution_run_default_1' },
    );

    expect(result).toMatchObject({ behavior: 'allow' });
    expect(client.agentState.requests['toolu_execution_run_default_1']).toBeUndefined();
  });

  it('does not auto-allow an opaque action_execute payload', async () => {
    const { session, client } = createPermissionHandlerSessionStub('unknown-action-still-prompts');
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);
    const signal = new AbortController();

    const pending = handler.handleToolCall(
      'mcp__happier__action_execute',
      { actionId: 'not.a.known.action', input: {} },
      { permissionMode: 'default' },
      { signal: signal.signal, toolUseId: 'toolu_unknown_action_1' },
    );
    await Promise.resolve();
    expect(client.agentState.requests.toolu_unknown_action_1).toBeDefined();
    await client.rpcHandlerManager.getHandler('permission')?.({ id: 'toolu_unknown_action_1', approved: false } as any);
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('auto-allows first-party Happier MCP tools when Happier action approval is the gate', async () => {
    const { session, client } = createPermissionHandlerSessionStub('happier-approval-gate-auto-allow');
    (session as any).accountSettings = {
      actionsSettingsV1: {
        v: 1,
        actions: {
          'session.list': {
            disabledSurfaces: [],
            approvalRequiredSurfaces: ['session_agent'],
          },
        },
      },
    };
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const signal = new AbortController();
    await expect(handler.handleToolCall(
      'mcp__happier__session_list',
      {},
      { permissionMode: 'default' },
      { signal: signal.signal, toolUseId: 'toolu_happier_session_list_1' },
    )).resolves.toMatchObject({ behavior: 'allow' });

    expect(client.agentState.requests.toolu_happier_session_list_1).toBeUndefined();
  });

  it('does not suppress provider prompts for custom MCP tools', async () => {
    const { session, client } = createPermissionHandlerSessionStub('custom-mcp-still-prompts');
    (session as any).accountSettings = {
      actionsSettingsV1: {
        v: 1,
        actions: {
          'session.list': {
            disabledSurfaces: [],
            approvalRequiredSurfaces: ['session_agent'],
          },
        },
      },
    };
    const { PermissionHandler } = await import('./permissionHandler');
    const handler = new PermissionHandler(session);

    const signal = new AbortController();
    const pending = handler.handleToolCall(
      'mcp__custom__session_list',
      {},
      { permissionMode: 'default' },
      { signal: signal.signal, toolUseId: 'toolu_custom_session_list_1' },
    );

    await Promise.resolve();
    expect(client.agentState.requests.toolu_custom_session_list_1).toMatchObject({
      tool: 'mcp__custom__session_list',
    });

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    await permissionRpc?.({ id: 'toolu_custom_session_list_1', approved: true } as any);
    await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
  });
});
