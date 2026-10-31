import { describe, expect, it } from 'vitest';

import * as directSessionsRpc from './daemonRpcV1';
import {
  DirectSessionsSourceSchema,
  DirectTranscriptRawMessageV1Schema,
  DirectTranscriptPageResponseSchema,
  DirectTranscriptReadAfterResponseSchema,
  resolveDirectTranscriptContinuation,
} from './daemonRpcV1';

describe('DirectSessionsSourceSchema', () => {
  it('accepts exact Codex user-home identity', () => {
    expect(DirectSessionsSourceSchema.parse({
      kind: 'codexHome',
      home: 'user',
      homePath: '/tmp/custom-codex-home',
    })).toEqual({
      kind: 'codexHome',
      home: 'user',
      homePath: '/tmp/custom-codex-home',
    });
  });

  it('accepts exact Codex connected-service profile identity', () => {
    expect(DirectSessionsSourceSchema.parse({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/connected/work/codex-home',
    })).toEqual({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/connected/work/codex-home',
    });
  });
});

describe('DirectTranscriptRawMessageV1Schema', () => {
  const item = {
    id: 'direct-1',
    createdAtMs: 1_700,
    raw: { role: 'agent', content: { type: 'output', data: { type: 'assistant' } } },
  };

  it('preserves canonical message-role metadata for downstream normalization', () => {
    expect(DirectTranscriptRawMessageV1Schema.parse({ ...item, messageRole: 'event' })).toMatchObject({
      messageRole: 'event',
    });
  });

  it('rejects invalid message-role metadata', () => {
    expect(DirectTranscriptRawMessageV1Schema.safeParse({ ...item, messageRole: 'not-a-role' }).success).toBe(false);
  });
});

describe('resolveDirectTranscriptContinuation', () => {
  it('authorizes adjacent continuation only for an explicit page limit', () => {
    expect(resolveDirectTranscriptContinuation({ truncated: false, truncationReason: 'page_limit' })).toBe('page_limit');
    expect(resolveDirectTranscriptContinuation({ truncated: true, truncationReason: 'page_limit' })).toBe('page_limit');
  });

  it('fails closed for source discontinuity and legacy truncation without a reason', () => {
    expect(resolveDirectTranscriptContinuation({ truncated: true, truncationReason: 'source_discontinuity' })).toBe('source_discontinuity');
    expect(resolveDirectTranscriptContinuation({ truncated: true })).toBe('source_discontinuity');
    expect(resolveDirectTranscriptContinuation({ truncated: false })).toBe('complete');
  });

  it('requires a usable adjacent cursor for page-limit responses', () => {
    expect(DirectTranscriptReadAfterResponseSchema.safeParse({
      ok: true,
      items: [],
      nextCursor: null,
      truncated: false,
      truncationReason: 'page_limit',
    }).success).toBe(false);
    expect(DirectTranscriptReadAfterResponseSchema.safeParse({
      ok: true,
      items: [],
      nextCursor: 'next-page',
      truncated: false,
      truncationReason: 'page_limit',
    }).success).toBe(true);

    expect(DirectTranscriptPageResponseSchema.safeParse({
      ok: true,
      items: [],
      nextCursor: null,
      tailCursor: 'tail',
      hasMore: true,
      truncated: true,
      truncationReason: 'page_limit',
    }).success).toBe(false);
    expect(DirectTranscriptPageResponseSchema.safeParse({
      ok: true,
      items: [],
      nextCursor: 'older-page',
      tailCursor: 'tail',
      hasMore: true,
      truncated: true,
      truncationReason: 'page_limit',
    }).success).toBe(true);
  });
});

describe('direct session follow lifecycle schemas', () => {
  it('parses attach, detach, and follow-policy requests', () => {
    const attachSchema = (directSessionsRpc as Record<string, any>).DirectSessionAttachRequestSchema;
    const detachSchema = (directSessionsRpc as Record<string, any>).DirectSessionDetachRequestSchema;
    const followPolicySchema = (directSessionsRpc as Record<string, any>).DirectSessionFollowPolicySetRequestSchema;

    expect(attachSchema.parse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'claude',
      remoteSessionId: 'remote-1',
      source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: 'project-1' },
      leaseId: 'lease-1',
      ttlMs: 30_000,
    })).toEqual({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'claude',
      remoteSessionId: 'remote-1',
      source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: 'project-1' },
      leaseId: 'lease-1',
      ttlMs: 30_000,
    });

    expect(detachSchema.parse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      leaseId: 'lease-1',
    })).toEqual({
      machineId: 'machine-1',
      sessionId: 'session-1',
      leaseId: 'lease-1',
    });

    expect(followPolicySchema.parse({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'claude',
      remoteSessionId: 'remote-1',
      source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: 'project-1' },
      enabled: true,
    })).toEqual({
      machineId: 'machine-1',
      sessionId: 'session-1',
      providerId: 'claude',
      remoteSessionId: 'remote-1',
      source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: 'project-1' },
      enabled: true,
    });
  });
});

describe.each([
  directSessionsRpc.DirectSessionTakeoverRequestSchema,
  directSessionsRpc.DirectSessionTakeoverPersistRequestSchema,
])('direct takeover terminal request', (schema) => {
  it('accepts legacy requests and rejects invalid terminal settings at the RPC boundary', () => {
    const request = { machineId: 'm1', sessionId: 's1' };
    expect(schema.parse(request)).toEqual(request);
    expect(schema.safeParse({ ...request, terminal: { mode: 'tmux', tmux: { isolated: 'true' } } }).success).toBe(false);
    expect(schema.safeParse({ ...request, terminal: { mode: 'integrated' } }).success).toBe(false);
  });
});
