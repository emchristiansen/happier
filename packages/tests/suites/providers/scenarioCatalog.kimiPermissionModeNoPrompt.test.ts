import { describe, expect, it } from 'vitest';

import { loadProvidersFromCliSpecs } from '../../src/testkit/providers/specs/providerSpecs';

describe('scenarioCatalog: kimi permission mode outside workspace', () => {
  it('does not schedule permission-mode scenarios before Kimi mode behavior is verified', async () => {
    const providers = await loadProvidersFromCliSpecs();
    const kimi = providers.find((provider) => provider.id === 'kimi');
    expect(kimi).toBeTruthy();
    if (!kimi) throw new Error('Missing provider spec for kimi');

    expect(kimi.permissions).toBeUndefined();
    expect([
      ...kimi.scenarioRegistry.tiers.smoke,
      ...kimi.scenarioRegistry.tiers.extended,
    ].some((scenarioId) => scenarioId.startsWith('permission_mode_'))).toBe(false);
  });
});
