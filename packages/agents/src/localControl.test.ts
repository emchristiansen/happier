import { describe, expect, it } from 'vitest';

import {
  getAgentLocalControlCapability,
  getAgentLocalControlCapabilityForSession,
  usesProviderAttachForLocalControl,
} from './localControl';

describe('agent local control capability', () => {
  it('exposes shared provider-attach local control for opencode', () => {
    expect(getAgentLocalControlCapability('opencode')).toEqual({
      supported: true,
      topology: 'shared',
      attachStrategy: 'provider_attach',
    });
    expect(usesProviderAttachForLocalControl('opencode')).toBe(true);
  });

  it('exposes tmux-backed exclusive local control for claude', () => {
    expect(getAgentLocalControlCapability('claude')).toEqual({
      supported: true,
      topology: 'exclusive',
      attachStrategy: 'tmux',
    });
    expect(usesProviderAttachForLocalControl('claude')).toBe(false);
  });

  it.each(['devin', 'kimi'] as const)('exposes tmux-backed exclusive local control for %s', (agentId) => {
    expect(getAgentLocalControlCapability(agentId)).toEqual({
      supported: true,
      topology: 'exclusive',
      attachStrategy: 'tmux',
    });
    expect(usesProviderAttachForLocalControl(agentId)).toBe(false);
  });

  it('projects Codex local control from the persisted runtime kind', () => {
    expect(getAgentLocalControlCapabilityForSession({
      agentId: 'codex',
      metadata: { codexBackendMode: 'appServer' },
    })).toEqual({
      supported: true,
      topology: 'shared',
      attachStrategy: 'provider_attach',
    });
    expect(getAgentLocalControlCapabilityForSession({
      agentId: 'codex',
      metadata: { codexBackendMode: 'acp' },
    })).toEqual({
      supported: true,
      topology: 'exclusive',
      attachStrategy: 'tmux',
    });
  });

  it('returns null for providers without local control', () => {
    expect(getAgentLocalControlCapability('gemini')).toBeNull();
    expect(usesProviderAttachForLocalControl('gemini')).toBe(false);
  });
});
