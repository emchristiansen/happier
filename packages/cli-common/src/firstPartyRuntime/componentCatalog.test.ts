import { describe, expect, it } from 'vitest';
import { getFirstPartyComponentCatalogEntry, resolveFirstPartyComponentPublicReleaseVariant } from './componentCatalog.js';

describe('optional CLI components', () => {
  it.each(['happier-memory-runtime', 'happier-difftastic'] as const)('%s shares CLI releases without exposing shims', (componentId) => {
    expect(getFirstPartyComponentCatalogEntry(componentId).releaseProductName).toBe(componentId);
    for (const channel of ['stable', 'preview', 'publicdev'] as const) {
      expect(resolveFirstPartyComponentPublicReleaseVariant({ componentId, channel }).installShims).toEqual([]);
    }
  });
});
