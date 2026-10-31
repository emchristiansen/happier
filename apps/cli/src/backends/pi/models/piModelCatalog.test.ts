import { describe, expect, it } from 'vitest';

import { createPiModelCatalogEntry } from './piModelCatalog';

describe('Pi model catalog identity', () => {
  it('retains the Pi provider when the native model id already contains a slash', () => {
    const raw = { provider: 'openrouter', modelId: 'anthropic/claude-sonnet', name: 'Claude Sonnet' };
    const entry = createPiModelCatalogEntry(raw);
    expect(entry).toMatchObject({ id: 'openrouter/anthropic/claude-sonnet', name: 'Claude Sonnet' });
    expect(createPiModelCatalogEntry({ ...raw, modelId: entry?.id })).toEqual(entry);
  });
});
