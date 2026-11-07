import { describe, expect, it } from 'vitest';

import {
  buildConnectedServicesDefaultAuthSettingsPatch,
  ConnectedServicesAdditionalDefaultAuthByAgentIdV1Schema,
  ConnectedServicesDefaultAuthByAgentIdV1Schema,
  readConnectedServicesDefaultAuthSettings,
} from './connectedServicesSettings.js';

describe('connected service saved default compatibility', () => {
  it('round trips disjoint service defaults and keeps the released V1 reader parseable', () => {
    const effective = { v: 1 as const, bindingsByAgentId: {
      codex: { v: 1 as const, bindingsByServiceId: {
        'openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
      } },
      agy: { v: 1 as const, bindingsByServiceId: {
        antigravity: { source: 'connected' as const, selection: 'group' as const, groupId: 'google-pool' },
      } },
    } };
    const patch = buildConnectedServicesDefaultAuthSettingsPatch(effective);
    expect(patch.connectedServicesDefaultAuthByAgentIdV1.bindingsByAgentId).toEqual({ codex: effective.bindingsByAgentId.codex });
    expect(patch.connectedServicesAdditionalDefaultAuthByAgentIdV1.bindingsByAgentId).toEqual({ agy: effective.bindingsByAgentId.agy });
    expect(readConnectedServicesDefaultAuthSettings(patch)).toEqual(effective);
    expect(ConnectedServicesDefaultAuthByAgentIdV1Schema.parse(effective).bindingsByAgentId).toEqual({});
    expect(ConnectedServicesAdditionalDefaultAuthByAgentIdV1Schema.safeParse({
      v: 1, bindingsByAgentId: { codex: effective.bindingsByAgentId.codex },
    }).success).toBe(false);
  });

  it('clears Antigravity selection without erasing another service default', () => {
    const settings = {
      connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {
        codex: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } } },
      } },
      connectedServicesAdditionalDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {
        agy: { v: 1, bindingsByServiceId: { antigravity: { source: 'connected', profileId: 'google-work' } } },
      } },
    };
    const effective = readConnectedServicesDefaultAuthSettings(settings);
    delete effective.bindingsByAgentId.agy;
    const next = buildConnectedServicesDefaultAuthSettingsPatch(effective);
    expect(next.connectedServicesAdditionalDefaultAuthByAgentIdV1.bindingsByAgentId).toEqual({});
    expect(readConnectedServicesDefaultAuthSettings(next).bindingsByAgentId.codex?.bindingsByServiceId['openai-codex'])
      .toMatchObject({ source: 'connected', profileId: 'work' });
  });
});
