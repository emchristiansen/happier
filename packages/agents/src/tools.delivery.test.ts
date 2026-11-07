import { describe, expect, it } from 'vitest';

import { AGENT_IDS } from './types';
import { AGENTS_CORE } from './manifest';
import {
  getAgentToolsCapability,
  isAgentToolsUnsupported,
  usesNativeMcpTools,
  usesShellBridgeTools,
} from './tools';

describe('agent tools delivery capability', () => {
  it('defines tools delivery metadata for every agent', () => {
    for (const agentId of AGENT_IDS) {
      expect(AGENTS_CORE[agentId].tools).toBeDefined();
      expect(AGENTS_CORE[agentId].tools.delivery).toMatch(/^(native_mcp|shell_bridge|unsupported)$/);
      expect(AGENTS_CORE[agentId].tools.support).toMatch(/^(supported|experimental|unsupported)$/);
    }
  });

  it('classifies native MCP providers through helper APIs', () => {
    expect(getAgentToolsCapability('claude')).toEqual({ delivery: 'native_mcp', support: 'supported' });
    expect(usesNativeMcpTools('claude')).toBe(true);
    expect(usesShellBridgeTools('claude')).toBe(false);
    expect(isAgentToolsUnsupported('claude')).toBe(false);
  });

  it('classifies Gemini as a native MCP provider through helper APIs', () => {
    expect(getAgentToolsCapability('gemini')).toEqual({ delivery: 'native_mcp', support: 'supported' });
    expect(usesNativeMcpTools('gemini')).toBe(true);
    expect(usesShellBridgeTools('gemini')).toBe(false);
    expect(isAgentToolsUnsupported('gemini')).toBe(false);
  });

  it('classifies ACP providers that pass Happier MCP servers as native MCP delivery', () => {
    for (const agentId of ['auggie', 'copilot', 'cursor', 'kilo', 'qwen'] as const) {
      expect(getAgentToolsCapability(agentId)).toEqual({ delivery: 'native_mcp', support: 'experimental' });
      expect(usesNativeMcpTools(agentId)).toBe(true);
      expect(usesShellBridgeTools(agentId)).toBe(false);
      expect(isAgentToolsUnsupported(agentId)).toBe(false);
    }
  });

  it('keeps observed Grok MCP negotiation experimental until authenticated tool QA passes', () => {
    expect(getAgentToolsCapability('grok')).toEqual({ delivery: 'native_mcp', support: 'experimental' });
    expect(usesNativeMcpTools('grok')).toBe(true);
    expect(isAgentToolsUnsupported('grok')).toBe(false);
  });

  it('classifies Devin as native MCP through its provider config adapter', () => {
    expect(getAgentToolsCapability('devin')).toEqual({ delivery: 'native_mcp', support: 'supported' });
    expect(usesNativeMcpTools('devin')).toBe(true);
    expect(usesShellBridgeTools('devin')).toBe(false);
    expect(isAgentToolsUnsupported('devin')).toBe(false);
  });
});
