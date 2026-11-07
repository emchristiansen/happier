import { describe, expect, it } from 'vitest';

import { resolveOpenCodeServerControlPollIntervals } from './controlPollIntervals';

describe('resolveOpenCodeServerControlPollIntervals', () => {
  it('uses an explicit server-control default independent of pending queue idle polling', () => {
    expect(resolveOpenCodeServerControlPollIntervals({})).toEqual({
      pollSleepMs: 2_000,
      turnActivePollSleepMs: 2_000,
    });
  });

  it('honors bounded control-plane polling overrides', () => {
    expect(resolveOpenCodeServerControlPollIntervals({
      HAPPIER_OPENCODE_SERVER_CONTROL_POLL_INTERVAL_MS: '25',
      HAPPIER_OPENCODE_SERVER_ACTIVE_CONTROL_POLL_INTERVAL_MS: '40',
    })).toEqual({
      pollSleepMs: 25,
      turnActivePollSleepMs: 40,
    });
  });
});
