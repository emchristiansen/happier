import { describe, expect, it } from 'vitest';

import {
  buildOpenCodeSessionScopedPermissionRuleset,
  canonicalizeOpenCodeConfiguredMcpToolName,
  projectOpenCodeSessionMcpServers,
  resolveOpenCodeChangeTitleToolNameForMcpClient,
} from './openCodeMcpToolNames';

describe('OpenCode session-scoped MCP projection', () => {
  it('projects every injected MCP name into a stable per-session namespace', () => {
    const first = projectOpenCodeSessionMcpServers('session-a', {
      happier: { command: '/bin/happier-mcp' },
      custom: { command: '/bin/custom-mcp' },
    });
    const second = projectOpenCodeSessionMcpServers('session-b', {
      happier: { command: '/bin/happier-mcp' },
      custom: { command: '/bin/custom-mcp' },
    });

    expect(first.registrations.map(({ originalName, projectedName }) => ({ originalName, projectedName }))).toEqual([
      { originalName: 'happier', projectedName: 'happier-session-session-a--happier' },
      { originalName: 'custom', projectedName: 'happier-session-session-a--custom' },
    ]);
    expect(second.registrations.map(({ projectedName }) => projectedName)).toEqual([
      'happier-session-session-b--happier',
      'happier-session-session-b--custom',
    ]);
    expect(first.requiredHappierServerName).toBe('happier-session-session-a--happier');
    expect(first.registrations.map(({ projectedName }) => projectedName))
      .not.toEqual(second.registrations.map(({ projectedName }) => projectedName));
  });

  it('keeps long colliding prefixes distinct within the released V2 namespace limit', () => {
    const sharedPrefix = `custom-${'same-prefix-'.repeat(8)}`;
    const projection = projectOpenCodeSessionMcpServers('session-a', {
      [`${sharedPrefix}first`]: { command: '/bin/first' },
      [`${sharedPrefix}second`]: { command: '/bin/second' },
    });
    const names = projection.registrations.map(({ projectedName }) => projectedName);

    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(names.map((name) => expect.stringMatching(/^[A-Za-z0-9_-]{64}$/)));
    expect(canonicalizeOpenCodeConfiguredMcpToolName(
      `${names[0]}_lookup`,
      projection,
    )).toBe(`mcp__${sharedPrefix}first__lookup`);
  });

  it('denies every other Happier session namespace while retaining the current mode for its own tools', () => {
    const projection = projectOpenCodeSessionMcpServers('session-a', {
      happier: { command: '/bin/happier-mcp' },
      custom: { command: '/bin/custom-mcp' },
    });
    const rules = buildOpenCodeSessionScopedPermissionRuleset('default', projection);

    expect(rules.slice(-9)).toEqual([
      { permission: 'happier-session-*', pattern: '*', action: 'deny' },
      { permission: 'happier-session-session-a--happier_*', pattern: '*', action: 'ask' },
      { permission: 'happier-session-session-a--custom_*', pattern: '*', action: 'ask' },
      { permission: 'happier-session-session-a--happier_change_title', pattern: '*', action: 'allow' },
      { permission: 'happier-session-session-a--happier_session_title_set', pattern: '*', action: 'allow' },
      { permission: 'happier-session-session-a--happier_action_execute', pattern: '*', action: 'allow' },
      { permission: 'happier-session-session-a--happier_action_spec_search', pattern: '*', action: 'allow' },
      { permission: 'happier-session-session-a--happier_action_spec_get', pattern: '*', action: 'allow' },
      { permission: 'happier-session-session-a--happier_action_options_resolve', pattern: '*', action: 'allow' },
    ]);
  });

  it('uses the projection for provider guidance while preserving canonical transcript names', () => {
    const projection = projectOpenCodeSessionMcpServers('session-a', {
      happier: { command: '/bin/happier-mcp' },
      custom: { command: '/bin/custom-mcp' },
    });
    const happier = projection.registrations.find(({ originalName }) => originalName === 'happier');

    expect(happier).toBeDefined();
    expect(resolveOpenCodeChangeTitleToolNameForMcpClient(happier!.projectedName)).toBe(
      'happier-session-session-a--happier_change_title',
    );
    expect(canonicalizeOpenCodeConfiguredMcpToolName(
      'happier-session-session-a--custom_lookup',
      projection,
    )).toBe('mcp__custom__lookup');
  });
});
