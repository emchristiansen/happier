import { describe, expect, it } from 'vitest';
import { HAPPIER_BUILT_IN_TOOL_NAMES } from '@/agent/tools/happierTools/catalog';

import {
  buildOpenCodeSessionScopedPermissionRuleset,
  canonicalizeOpenCodeConfiguredMcpToolName,
  projectOpenCodeSessionMcpServers,
  resolveOpenCodeChangeTitleToolNameForMcpClient,
} from './openCodeMcpToolNames';

const REAL_SESSION_ID = 'cmexample0000000000000000';
// Amazon Bedrock rejects tool names over 64 characters.
const MODEL_TOOL_NAME_MAX_LENGTH = 64;

function happierMcpToolNames(): string[] {
  return [...HAPPIER_BUILT_IN_TOOL_NAMES];
}

function projectedNameOf(
  projection: ReturnType<typeof projectOpenCodeSessionMcpServers>,
  originalName: string,
): string {
  const registration = projection.registrations.find((entry) => entry.originalName === originalName);
  expect(registration).toBeDefined();
  return registration!.projectedName;
}

describe('OpenCode session-scoped MCP projection', () => {
  it('projects every injected MCP name into a stable per-session namespace', () => {
    const servers = {
      happier: { command: '/bin/happier-mcp' },
      custom: { command: '/bin/custom-mcp' },
    };
    const first = projectOpenCodeSessionMcpServers('session-a', servers);
    const again = projectOpenCodeSessionMcpServers('session-a', servers);
    const second = projectOpenCodeSessionMcpServers('session-b', servers);
    const namesOf = (projection: typeof first) => projection.registrations.map(({ projectedName }) => projectedName);

    expect(first.registrations.map(({ originalName }) => originalName)).toEqual(['happier', 'custom']);
    expect(namesOf(again)).toEqual(namesOf(first));
    expect(namesOf(first)).not.toEqual(namesOf(second));
    expect(new Set(namesOf(first)).size).toBe(2);
    expect(namesOf(first)).toEqual(namesOf(first).map((name) => expect.stringMatching(/^happier-session-[a-z0-9_-]+$/)));
    expect(first.requiredHappierServerName).toBe(projectedNameOf(first, 'happier'));
  });

  it('keeps long colliding prefixes distinct within the client name limit', () => {
    const sharedPrefix = `custom-${'same-prefix-'.repeat(8)}`;
    const projection = projectOpenCodeSessionMcpServers('session-a', {
      [`${sharedPrefix}first`]: { command: '/bin/first' },
      [`${sharedPrefix}second`]: { command: '/bin/second' },
    });
    const names = projection.registrations.map(({ projectedName }) => projectedName);
    const maxClientNameLength = MODEL_TOOL_NAME_MAX_LENGTH - 1 - Math.max(...happierMcpToolNames().map((name) => name.length));

    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(names.map((name) => expect.stringMatching(/^happier-session-[a-z0-9]{7}$/)));
    for (const name of names) expect(name.length).toBeLessThanOrEqual(maxClientNameLength);
    expect(canonicalizeOpenCodeConfiguredMcpToolName(
      `${names[0]}_lookup`,
      projection,
    )).toBe(`mcp__${sharedPrefix}first__lookup`);
  });

  it('keeps every Happier MCP tool name within the model tool-name limit for a real session id', () => {
    const projection = projectOpenCodeSessionMcpServers(REAL_SESSION_ID, {
      happier: { command: '/bin/happier-mcp' },
    });
    const clientName = projection.requiredHappierServerName!;
    const toolNames = happierMcpToolNames();

    expect(clientName.startsWith('happier-session-')).toBe(true);
    expect(toolNames.length).toBeGreaterThan(0);
    for (const toolName of toolNames) {
      const modelToolName = `${clientName}_${toolName}`;
      expect(modelToolName.length, modelToolName).toBeLessThanOrEqual(MODEL_TOOL_NAME_MAX_LENGTH);
    }
  });

  it('denies every other Happier session namespace while retaining the current mode for its own tools', () => {
    const projection = projectOpenCodeSessionMcpServers('session-a', {
      happier: { command: '/bin/happier-mcp' },
      custom: { command: '/bin/custom-mcp' },
    });
    const happier = projectedNameOf(projection, 'happier');
    const custom = projectedNameOf(projection, 'custom');
    const rules = buildOpenCodeSessionScopedPermissionRuleset('default', projection);

    expect(rules.slice(-9)).toEqual([
      { permission: 'happier-session-*', pattern: '*', action: 'deny' },
      { permission: `${happier}_*`, pattern: '*', action: 'ask' },
      { permission: `${custom}_*`, pattern: '*', action: 'ask' },
      { permission: `${happier}_change_title`, pattern: '*', action: 'allow' },
      { permission: `${happier}_session_title_set`, pattern: '*', action: 'allow' },
      { permission: `${happier}_action_execute`, pattern: '*', action: 'allow' },
      { permission: `${happier}_action_spec_search`, pattern: '*', action: 'allow' },
      { permission: `${happier}_action_spec_get`, pattern: '*', action: 'allow' },
      { permission: `${happier}_action_options_resolve`, pattern: '*', action: 'allow' },
    ]);
  });

  it('uses the projection for provider guidance while preserving canonical transcript names', () => {
    const projection = projectOpenCodeSessionMcpServers('session-a', {
      happier: { command: '/bin/happier-mcp' },
      custom: { command: '/bin/custom-mcp' },
    });
    const happier = projectedNameOf(projection, 'happier');
    const custom = projectedNameOf(projection, 'custom');

    expect(resolveOpenCodeChangeTitleToolNameForMcpClient(happier)).toBe(`${happier}_change_title`);
    expect(canonicalizeOpenCodeConfiguredMcpToolName(
      `${custom}_lookup`,
      projection,
    )).toBe('mcp__custom__lookup');
  });
});
