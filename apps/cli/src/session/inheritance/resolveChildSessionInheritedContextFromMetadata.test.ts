import { describe, expect, it } from 'vitest';

import { CONNECTED_SERVICE_INHERITANCE_STRIPPED_FIELDS } from '@happier-dev/protocol';

import {
  CHILD_SESSION_INHERITANCE_FIELD_SETS,
  resolveChildSessionInheritedContextFromMetadata,
} from './resolveChildSessionInheritedContextFromMetadata';

describe('resolveChildSessionInheritedContextFromMetadata', () => {
  it('keeps fork inheritance limited to permission, model, mode, config, and connected services', () => {
    const inherited = resolveChildSessionInheritedContextFromMetadata({
      metadata: {
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 101,
        modelOverrideV1: { v: 1, updatedAt: 102, modelId: 'gpt-test' },
        sessionModeOverrideV1: { v: 1, updatedAt: 103, modeId: 'plan' },
        sessionConfigOptionOverridesV1: {
          v: 1,
          updatedAt: 104,
          overrides: {
            reasoning_effort: { updatedAt: 104, value: 'high' },
          },
        },
        connectedServices: {
          v: 1,
          bindingsByServiceId: {
            'openai-codex': {
              source: 'connected',
              selection: 'profile',
              profileId: 'codex1',
            },
          },
        },
        connectedServicesUpdatedAt: 105,
        mcpSelectionV1: {
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: ['repo-tools'],
          forceExcludeServerIds: [],
        },
        profileId: 'standalone-profile',
      },
      fields: CHILD_SESSION_INHERITANCE_FIELD_SETS.fork,
      providerId: 'codex',
    });

    expect(inherited.spawn).toEqual({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 101,
      modelId: 'gpt-test',
      modelUpdatedAt: 102,
      agentModeId: 'plan',
      agentModeUpdatedAt: 103,
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'codex1',
          },
        },
      },
      connectedServicesUpdatedAt: 105,
    });
    expect(inherited.metadata).toEqual({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 101,
      modelOverrideV1: { v: 1, updatedAt: 102, modelId: 'gpt-test' },
      sessionModeOverrideV1: { v: 1, updatedAt: 103, modeId: 'plan' },
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 104,
        overrides: {
          reasoning_effort: { updatedAt: 104, value: 'high' },
        },
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'profile',
            profileId: 'codex1',
          },
        },
      },
      connectedServicesUpdatedAt: 105,
    });
    expect(inherited.sources.mcpSelection).toBeUndefined();
    expect(inherited.sources.profileId).toBeUndefined();
    expect('mcpSelection' in inherited.spawn).toBe(false);
    expect('profileId' in inherited.spawn).toBe(false);
    expect('mcpSelectionV1' in inherited.metadata).toBe(false);
    expect('profileId' in inherited.metadata).toBe(false);
  });

  it('inherits session-agent spawn mcpSelectionV1 and standalone profileId from metadata with sources', () => {
    const inherited = resolveChildSessionInheritedContextFromMetadata({
      metadata: {
        mcpSelectionV1: {
          v: 1,
          managedServersEnabled: false,
          forceIncludeServerIds: ['repo-tools'],
          forceExcludeServerIds: ['legacy-tool'],
        },
        profileId: 'standalone-profile',
      },
      fields: CHILD_SESSION_INHERITANCE_FIELD_SETS.sessionAgentSpawn,
      providerId: 'codex',
    });

    expect(inherited.spawn).toEqual({
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['repo-tools'],
        forceExcludeServerIds: ['legacy-tool'],
      },
      profileId: 'standalone-profile',
    });
    expect(inherited.metadata).toEqual({
      mcpSelectionV1: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['repo-tools'],
        forceExcludeServerIds: ['legacy-tool'],
      },
      profileId: 'standalone-profile',
    });
    expect(inherited.sources).toEqual({
      mcpSelection: { kind: 'metadata', key: 'mcpSelectionV1' },
      profileId: { kind: 'metadata', key: 'profileId' },
    });
  });

  it('preserves per-model options and context window on inherited session model state', () => {
    const availableModels = [
      {
        id: 'gpt-5.6-sol',
        name: 'GPT 5.6 Sol',
        description: 'Latest frontier agentic coding model.',
        contextWindowTokens: 272000,
        modelOptions: [
          {
            id: 'reasoning_effort',
            name: 'Thinking',
            type: 'select',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low', description: 'Fast responses with lighter reasoning' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
      },
      {
        id: 'gpt-5.4-mini',
        name: 'GPT 5.4 Mini',
      },
    ];
    const inherited = resolveChildSessionInheritedContextFromMetadata({
      metadata: {
        sessionModelsV1: {
          v: 1,
          provider: 'codex',
          updatedAt: 200,
          currentModelId: 'gpt-5.6-sol',
          availableModels,
        },
        acpSessionModelsV1: {
          v: 1,
          provider: 'codex',
          updatedAt: 201,
          currentModelId: 'gpt-5.6-sol',
          availableModels,
        },
      },
      fields: CHILD_SESSION_INHERITANCE_FIELD_SETS.fork,
      providerId: 'codex',
    });

    expect(inherited.metadata.sessionModelsV1).toEqual({
      v: 1,
      provider: 'codex',
      updatedAt: 200,
      currentModelId: 'gpt-5.6-sol',
      availableModels,
    });
    expect(inherited.metadata.acpSessionModelsV1).toEqual({
      v: 1,
      provider: 'codex',
      updatedAt: 201,
      currentModelId: 'gpt-5.6-sol',
      availableModels,
    });
  });

  it('drops malformed model options while keeping the valid model entries on inheritance', () => {
    const inherited = resolveChildSessionInheritedContextFromMetadata({
      metadata: {
        sessionModelsV1: {
          v: 1,
          provider: 'codex',
          updatedAt: 200,
          currentModelId: 'gpt-5.6-sol',
          availableModels: [
            {
              id: 'gpt-5.6-sol',
              name: 'GPT 5.6 Sol',
              contextWindowTokens: 'not-a-number',
              modelOptions: [
                { id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'medium' },
                { id: '', name: 'Broken', type: 'select', currentValue: 'x' },
                { id: 'bad-value', name: 'Bad', type: 'select', currentValue: { nested: true } },
                'not-an-option',
              ],
            },
          ],
        },
      },
      fields: CHILD_SESSION_INHERITANCE_FIELD_SETS.fork,
      providerId: 'codex',
    });

    expect(inherited.metadata.sessionModelsV1).toEqual({
      v: 1,
      provider: 'codex',
      updatedAt: 200,
      currentModelId: 'gpt-5.6-sol',
      availableModels: [
        {
          id: 'gpt-5.6-sol',
          name: 'GPT 5.6 Sol',
          modelOptions: [
            { id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'medium' },
          ],
        },
      ],
    });
  });

  it('ignores invalid spawn-only metadata fields for session-agent spawn', () => {
    const inherited = resolveChildSessionInheritedContextFromMetadata({
      metadata: {
        mcpSelectionV1: 'not-a-selection',
        profileId: '   ',
      },
      fields: CHILD_SESSION_INHERITANCE_FIELD_SETS.sessionAgentSpawn,
      providerId: 'codex',
    });

    expect(inherited.spawn).toEqual({});
    expect(inherited.metadata).toEqual({});
    expect(inherited.sources).toEqual({});
  });

  const forgedValues: Record<string, unknown> = {
    initialProfileId: 'B',
    member: { assignment: 'per_session', profileId: 'B', decisionId: 'parent-decision', reason: 'initial_sampled', appliedAtMs: 1 },
    materializedAssignment: { profileId: 'B', decisionId: 'parent-decision', reason: 'initial_sampled', materializedAtMs: 1 },
    pendingAssignment: { profileId: 'B' },
    decisionId: 'parent-decision',
  };
  for (const field of CONNECTED_SERVICE_INHERITANCE_STRIPPED_FIELDS) {
    for (const [setName, fields] of Object.entries(CHILD_SESSION_INHERITANCE_FIELD_SETS)) {
      if (!fields.includes('connectedServices')) continue;
      it(`${setName} child does not inherit the parent's ${field} (spec A.1)`, () => {
        const group = { source: 'connected', selection: 'group', groupId: 'pool' };
        const inherited = resolveChildSessionInheritedContextFromMetadata({
          metadata: { connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': { ...group, [field]: forgedValues[field] } } } },
          providerId: 'claude',
          fields,
        });
        const expected = { v: 1, bindingsByServiceId: { 'claude-subscription': group } };
        expect(inherited.spawn.connectedServices).toEqual(expected);
        expect(inherited.metadata.connectedServices).toEqual(expected);
      });
    }
  }
});
