import { describe, expect, it } from 'vitest';

import { loadCliProviderSpecs } from '../../src/testkit/providers/specs/providerSpecs';

describe('providers: kimi auth policy', () => {
  it('uses the authenticated host state established by kimi login', async () => {
    const specs = await loadCliProviderSpecs();
    const kimi = specs.find((spec) => spec.id === 'kimi');
    expect(kimi).toBeTruthy();
    expect(kimi?.auth).toEqual({ mode: 'host' });
  });
});
