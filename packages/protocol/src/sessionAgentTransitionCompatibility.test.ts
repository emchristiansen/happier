import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { getActionSpec } from './actions/actionSpecs.js';
import { SESSION_AGENT_TRANSITION_VECTORS as V } from './sessionAgentTransitionVectors.js';
import { SessionForkRpcParamsSchema } from './sessionFork.js';
import { AcpConfigOptionOverridesV1Schema } from './sessionMetadata/metadataOverridesV1.js';
import { SessionAgentTransitionSelectionV1Schema } from './sessionAgentTransition.js';

// Published CLI stable 0.2.15 and preview 0.2.15-preview.1 linux-x64.json
// both pin 22ac8263cfdbcdb845441b9044ff18199cf7652e. This is the selection
// reader from that immutable source's sessionAgentTransition.ts, not a schema
// derived from the current reader. Retire when these strict peers are unsupported.
const ReleasedTransitionSelectionSchema = z.object({
  v: z.literal(1),
  agentId: z.string().trim().min(1).max(128),
  modelId: z.string().trim().min(1).max(256).optional(),
  providerConnectionId: z.string().trim().min(1).max(128).nullable().optional(),
  acpSessionModeId: z.string().trim().min(1).max(128).nullable().optional(),
  sessionConfigOptionOverrides: AcpConfigOptionOverridesV1Schema.optional(),
}).strict().superRefine((selection, ctx) => {
  if (selection.providerConnectionId == null) return;
  if (typeof selection.modelId === 'string' && selection.modelId.length > 0) return;
  ctx.addIssue({ code: 'custom', path: ['modelId'], message: 'modelId is required when providerConnectionId is set.' });
});

describe('compat — configured target selections and released inspection readers', () => {
  it('keeps built-in selections readable while refusing exact configured identity', () => {
    const builtIn = { v: 1, agentId: 'claude' };
    const configured = { v: 1, agentId: 'customAcp', backendTarget: { kind: 'configuredAcpBackend', backendId: 'b' } };
    expect(ReleasedTransitionSelectionSchema.safeParse(builtIn).success).toBe(true);
    expect(SessionAgentTransitionSelectionV1Schema.safeParse(builtIn).success).toBe(true);
    expect(SessionAgentTransitionSelectionV1Schema.safeParse(configured).success).toBe(true);
    expect(ReleasedTransitionSelectionSchema.safeParse(configured).success).toBe(false);
    // The released batch reader has an array of that strict selection. One
    // unsupported row rejects the whole request; clients must partition it.
    const releasedBatch = z.object({ v: z.literal(1), sourceSessionId: z.string().trim().min(1), selections: z.array(ReleasedTransitionSelectionSchema).min(1) }).strict();
    expect(releasedBatch.safeParse({ v: 1, sourceSessionId: 's', selections: [builtIn, configured] }).success).toBe(false);
    expect(releasedBatch.safeParse({ v: 1, sourceSessionId: 's', selections: [builtIn] }).success).toBe(true);
  });
});

/**
 * Section 6.7 compatibility directions for the predecessor tree.
 *
 * One direction in the successor's matrix has no protocol-level counterpart
 * here: there is no `MachineOperationProtocolCapabilitiesV1` in this tree, so
 * there is nothing to keep byte-equivalent and no leaf to accidentally add.
 *
 * There is also no `SessionSpawnNewInputV2`. `sourceContext` is carried on the
 * `session.spawn_new` Action input (`SessionSpawnNewInputSchema`, declared
 * inline in `actions/actionSpecs.ts`), which IS `.strict()` — so a daemon that
 * predates the field rejects the operation exactly as the successor does. The
 * daemon-local `SpawnDaemonSessionRequestCompatSchema` beneath it is a plain
 * `z.object`, but it is not the ingress a client sends `sourceContext` on. The
 * Action input's strict rejection is the compatibility boundary here;
 * `session.continuation.inspect` is not a source-context capability handshake.
 */

/** The strategy vocabulary as released, before `native` existed. */
const ReleasedForkStrategySchema = z.enum([
  'auto',
  'provider_native',
  'acp_fork_latest',
  'replay',
]);

const ReleasedForkRpcParamsSchema = SessionForkRpcParamsSchema.safeExtend({
  strategy: ReleasedForkStrategySchema.optional(),
});

describe('compat — new client + old daemon, generic native fork intent', () => {
  it('is rejected outright rather than downgraded to a Replay fork', () => {
    const request = V.fork.valid.nativeIntent;

    expect(SessionForkRpcParamsSchema.safeParse(request).success).toBe(true);

    // The enum sits inside a `.strict()` params object, so a daemon that
    // predates `native` refuses the request. There is no path where the user
    // asks for Native and silently receives a Replay fork.
    expect(ReleasedForkRpcParamsSchema.safeParse(request).success).toBe(false);
  });
});

describe('compat — old client + new daemon, fork', () => {
  it('still accepts a fork request with neither strategy nor requestId', () => {
    expect(
      SessionForkRpcParamsSchema.safeParse({
        v: 1,
        parentSessionId: 'sess_01',
        forkPoint: { type: 'latest' },
      }).success,
    ).toBe(true);
  });

  it('keeps the native coalescing key this tree already ships', () => {
    expect(SessionForkRpcParamsSchema.safeParse(V.fork.valid.withRequestId).success).toBe(true);
    expect(SessionForkRpcParamsSchema.safeParse(V.fork.invalid.blankRequestId).success).toBe(false);
  });
});

describe('compat — sourceContext on the session.spawn_new Action input', () => {
  const spawnNewInputSchema = getActionSpec('session.spawn_new').inputSchema;

  it('accepts the closed source recipe on the current input', () => {
    const parsed = spawnNewInputSchema.safeParse({
      directory: '/repo',
      agentId: 'claude',
      sourceContext: V.sourceContext.valid.exactSeq,
    });
    expect(parsed.success).toBe(true);
  });

  it('is refused outright by a daemon that predates the field', () => {
    // The input is `.strict()`, so a daemon whose build does not declare a
    // field rejects the whole operation rather than stripping it and creating a
    // child with no source lineage. This Action input is the operation-scoped
    // degradation boundary; authoring does not negotiate it through inspection.
    expect(
      spawnNewInputSchema.safeParse({
        directory: '/repo',
        agentId: 'claude',
        fieldThisBuildDoesNotDeclare: { v: 1 },
      }).success,
    ).toBe(false);
  });
});
