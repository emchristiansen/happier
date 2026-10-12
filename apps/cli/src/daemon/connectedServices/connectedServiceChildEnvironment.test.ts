import { describe, expect, it } from 'vitest';

import {
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ConnectedServiceResolvedSelection } from './materialize/materializeConnectedServicesForSpawn';

import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
  readConnectedServiceMaterializedEnvKeysFromEnv,
  resolveConnectedServiceRuntimeAuthContextFromEnv,
  resolveConnectedServiceRuntimeAuthContextFromSessionMetadata,
  resolveConnectedServiceRuntimeAuthContextFromSelection,
  readConnectedServiceChildSelectionsFromEnv,
  serializeConnectedServiceChildSelections,
  serializeConnectedServiceMaterializedEnvKeys,
  stripInheritedConnectedServiceEnvironment,
} from './connectedServiceChildEnvironment';

describe('connectedServiceChildEnvironment runtime auth context', () => {
  it('resolves group selections to the active profile and group id', () => {
    expect(resolveConnectedServiceRuntimeAuthContextFromSelection({
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: 'happier',
      activeProfileId: 'bot',
      fallbackProfileId: 'leeroy',
      generation: 3,
    }, 'openai-codex')).toEqual({
      serviceId: 'openai-codex',
      profileId: 'bot',
      groupId: 'happier',
    });
  });

  it('resolves profile selections without a group id', () => {
    expect(resolveConnectedServiceRuntimeAuthContextFromSelection({
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: 'leeroy',
    }, 'openai-codex')).toEqual({
      serviceId: 'openai-codex',
      profileId: 'leeroy',
      groupId: null,
    });
  });

  it('resolves selections from child process env', () => {
    expect(resolveConnectedServiceRuntimeAuthContextFromEnv({
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
        kind: 'group',
        serviceId: 'openai-codex',
        groupId: 'happier',
        activeProfileId: 'bot',
        fallbackProfileId: 'leeroy',
        generation: 3,
      }]),
    }, 'openai-codex')).toEqual({
      serviceId: 'openai-codex',
      profileId: 'bot',
      groupId: 'happier',
    });
  });

  it('round-trips the exact credential revision in the child selection envelope', () => {
    const selections = new Map<ConnectedServiceId, ConnectedServiceResolvedSelection>([['gemini', {
      kind: 'group' as const,
      serviceId: 'gemini' as const,
      groupId: 'main',
      activeProfileId: 'work',
      fallbackProfileId: 'backup',
      generation: 7,
      credentialRevision: ConnectedServiceCredentialRevisionV1Schema.parse('csr_abcdefghijklmnopqrstuv'),
      record: {} as never,
      policy: null,
    }]]);
    const serialized = serializeConnectedServiceChildSelections(selections);

    expect(readConnectedServiceChildSelectionsFromEnv({
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: serialized ?? undefined,
    })).toEqual([expect.objectContaining({
      serviceId: 'gemini',
      groupId: 'main',
      generation: 7,
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    })]);
  });

  it('resolves the current connected-service binding from session metadata', () => {
    const connectedServices = {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: 'happier',
          profileId: 'backup',
        },
      },
    } satisfies ConnectedServiceBindingsV1;
    expect(ConnectedServiceBindingsV1Schema.safeParse(connectedServices).success).toBe(true);

    expect(resolveConnectedServiceRuntimeAuthContextFromSessionMetadata({
      getMetadataSnapshot: () => ({ connectedServices }),
    }, 'openai-codex')).toEqual({
      serviceId: 'openai-codex',
      profileId: 'backup',
      groupId: 'happier',
    });
  });

  it('serializes materialized env keys without values', () => {
    const serialized = serializeConnectedServiceMaterializedEnvKeys({
      CLAUDE_CODE_OAUTH_TOKEN: 'secret-token',
      CLAUDE_CONFIG_DIR: '/tmp/connected-claude',
    });

    expect(serialized).not.toContain('secret-token');
    expect(readConnectedServiceMaterializedEnvKeysFromEnv({
      [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: serialized ?? undefined,
    })).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']);
  });

  it('removes only inherited connected-service authority before composing a child runtime', () => {
    const inheritedSelections = JSON.stringify([{ serviceId: 'openai-codex', source: 'connected' }]);
    const stripped = stripInheritedConnectedServiceEnvironment({
      OPENAI_API_KEY: 'connected-secret',
      CODEX_HOME: '/tmp/connected-codex',
      NATIVE_RUNTIME_TOKEN: 'native-secret',
      [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: inheritedSelections,
      [HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]: JSON.stringify([
        'OPENAI_API_KEY',
        'CODEX_HOME',
      ]),
      HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT: '/tmp/connected-root',
    });

    expect(stripped).toEqual({
      NATIVE_RUNTIME_TOKEN: 'native-secret',
    });
  });
});
