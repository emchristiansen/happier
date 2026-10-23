import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listBuiltInHappierTools } from '@/agent/tools/happierTools/listBuiltInHappierTools';

const env = process.env;

describe('registerHappierMcpBridgeTools', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  });

  it('registers only the currently enabled Happier MCP tools and forwards calls', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['session_agent'], disabledPlacements: [] },
      },
    });

    const { registerHappierMcpBridgeTools } = await import('./registerHappierMcpBridgeTools');
    const calls: any[] = [];
    const registrar = {
      registerTool: (name: string, _def: any, handler: (args: any) => Promise<any>) => {
        calls.push({ name, handler });
      },
    };

    const forwarded: any[] = [];
    registerHappierMcpBridgeTools(registrar as any, {
      callHttpTool: async (name: string, args: unknown) => {
        forwarded.push({ name, args });
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
    });

    const names = calls.map((c) => c.name);
    expect(names).toEqual(listBuiltInHappierTools({ surface: 'session_agent' }).map((tool) => tool.name));
    expect(names).toContain('change_title');
    expect(names).not.toContain('happier__change_title');
    expect(names).not.toContain('happy__change_title');
    expect(names).not.toContain('review_start');
    expect(names).not.toContain('subagents_plan_start');
    expect(names).not.toContain('subagents_delegate_start');
    expect(names).not.toContain('execution_run_start');

    const actionExecute = calls.find((c) => c.name === 'action_execute');
    expect(actionExecute).toBeTruthy();
    const res = await actionExecute.handler({
      actionId: 'subagents.delegate.start',
      input: {
        instructions: 'Delegate.',
        backendTargetKeys: ['agent:claude'],
      },
    });
    expect(res.isError).toBe(false);
    expect(forwarded[0]).toEqual({
      name: 'action_execute',
      args: {
        actionId: 'subagents.delegate.start',
        input: {
          instructions: 'Delegate.',
          backendTargetKeys: ['agent:claude'],
        },
      },
    });
  });

  it('forwards only the provider tool-call id from the upstream request _meta', async () => {
    const { registerHappierMcpBridgeTools } = await import('./registerHappierMcpBridgeTools');
    const handlers = new Map<string, (args: any, extra?: unknown) => Promise<any>>();
    const forwarded: unknown[][] = [];
    registerHappierMcpBridgeTools({
      registerTool: (name: string, _def: any, handler: (args: any, extra?: unknown) => Promise<any>) => {
        handlers.set(name, handler);
      },
    }, {
      callHttpTool: async (...args: unknown[]) => {
        forwarded.push(args);
        return { content: [{ type: 'text', text: 'ok' }], isError: false };
      },
    });

    const send = handlers.get('action_execute');
    if (!send) throw new Error('Expected action_execute to be registered');
    const args = { actionId: 'session.message.send', input: { message: 'hi' } };
    await send(args, { requestId: 3, _meta: { 'claudecode/toolUseId': 'toolu_9', progressToken: 'up-1' } });
    await send(args, { requestId: 4 });

    expect(forwarded[0]).toEqual(['action_execute', args, { 'claudecode/toolUseId': 'toolu_9' }]);
    expect(forwarded[1]).toEqual(['action_execute', args]);
  });
});
