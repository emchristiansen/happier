import { AGENT_METHODS, CLIENT_METHODS, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';

import {
  ACP_SDK_AGENT_METHOD_DISPOSITION,
  ACP_SDK_CLIENT_METHOD_DISPOSITION,
  ACP_SDK_SESSION_UPDATE_DISPOSITION,
  buildUnknownAcpSessionUpdateDiagnostic,
  classifyAcpSessionUpdateDisposition,
} from '../sdkContractDisposition';

describe('ACP SDK 1.2 contract disposition', () => {
  it('classifies every public request/notification method exposed by the installed SDK', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(Object.keys(ACP_SDK_AGENT_METHOD_DISPOSITION).sort())
      .toEqual(Object.values(AGENT_METHODS).sort());
    expect(Object.keys(ACP_SDK_CLIENT_METHOD_DISPOSITION).sort())
      .toEqual(Object.values(CLIENT_METHODS).sort());
  });

  it('does not classify unregistered terminal methods as integrated', () => {
    expect(ACP_SDK_CLIENT_METHOD_DISPOSITION['terminal/create']).toBe('supported_not_advertised');
    expect(ACP_SDK_CLIENT_METHOD_DISPOSITION['terminal/output']).toBe('supported_not_advertised');
    expect(ACP_SDK_CLIENT_METHOD_DISPOSITION['terminal/release']).toBe('supported_not_advertised');
    expect(ACP_SDK_CLIENT_METHOD_DISPOSITION['terminal/wait_for_exit']).toBe('supported_not_advertised');
    expect(ACP_SDK_CLIENT_METHOD_DISPOSITION['terminal/kill']).toBe('supported_not_advertised');
  });

  it('classifies session/delete as integrated once the direct-session candidate action consumes it', () => {
    expect(ACP_SDK_AGENT_METHOD_DISPOSITION['session/delete']).toBe('integrated');
  });

  it('keeps every stable session-update variant explicit at compile time', () => {
    expect(Object.keys(ACP_SDK_SESSION_UPDATE_DISPOSITION).sort()).toEqual([
      'agent_message_chunk',
      'agent_thought_chunk',
      'available_commands_update',
      'config_option_update',
      'current_mode_update',
      'plan',
      'plan_removed',
      'plan_update',
      'session_info_update',
      'tool_call',
      'tool_call_update',
      'usage_update',
      'user_message_chunk',
    ]);
  });

  it('classifies stable variants and bounds unknown-extension diagnostics without payload values', () => {
    expect(classifyAcpSessionUpdateDisposition('session_info_update')).toEqual({
      kind: 'stable',
      disposition: 'integrated',
    });
    expect(classifyAcpSessionUpdateDisposition('vendor/custom_update')).toEqual({
      kind: 'unknown_extension',
    });

    const diagnostic = buildUnknownAcpSessionUpdateDiagnostic({
      sessionUpdate: 'vendor/'.concat('x'.repeat(300)),
      ['provider-key-'.concat('k'.repeat(500))]: 'must-not-appear',
      privateSecret: 'must-not-appear',
      nested: { private: 'must-not-appear' },
      ...Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`key-${index}`, index])),
    });
    expect(diagnostic.sessionUpdate.length).toBeLessThanOrEqual(128);
    expect(diagnostic.keys).toHaveLength(50);
    expect(diagnostic.keys.every((key) => key.length <= 128)).toBe(true);
    expect(diagnostic.truncatedKeyCount).toBe(14);
    expect(JSON.stringify(diagnostic)).not.toContain('must-not-appear');
  });

  it('classifies stable plan lifecycle updates as integrated only after handler coverage exists', () => {
    expect(ACP_SDK_SESSION_UPDATE_DISPOSITION.plan_update).toBe('integrated');
    expect(ACP_SDK_SESSION_UPDATE_DISPOSITION.plan_removed).toBe('integrated');
  });
});
