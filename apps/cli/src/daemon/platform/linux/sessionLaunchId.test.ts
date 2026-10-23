import { describe, expect, it } from 'vitest';

import { createSessionLaunchId, sessionLaunchScopeUnitName, type SessionLaunchId } from './sessionLaunchId';
import { buildSystemdUserScopedLaunchSpec } from './systemdUserResourceGovernor';

describe('session launch id', () => {
  it('names each launch attempt\'s scope from a fresh launch id', () => {
    const launchSpec = { filePath: '/runner', args: ['codex'] };
    const unitArg = (launchId: SessionLaunchId) => buildSystemdUserScopedLaunchSpec({ launchId, launchSpec })
      .args.find((arg) => arg.startsWith('--unit='));

    const first = createSessionLaunchId();
    const second = createSessionLaunchId();
    expect(first).not.toBe(second);
    expect(unitArg(first)).toMatch(/^--unit=happier-launch-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.scope$/u);
    expect(unitArg(first)).toBe(`--unit=happier-launch-${first}.scope`);
    expect(unitArg(second)).toBe(`--unit=happier-launch-${second}.scope`);
  });

  it('is the scope name\'s only variable part', () => {
    const launchId = createSessionLaunchId();
    expect(sessionLaunchScopeUnitName(launchId)).toBe(`happier-launch-${launchId}.scope`);
  });
});
