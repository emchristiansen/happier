import { describe, expect, it } from 'vitest';

import { resolveWebappUrlFromServerUrl } from './resolveWebappUrlFromServerUrl';

describe('resolveWebappUrlFromServerUrl', () => {
    it('points the hosted API at the preferred cloud client', () => {
        expect(resolveWebappUrlFromServerUrl('https://api.happier.dev'))
            .toBe('https://cloud.happier.dev');
    });

    it('preserves a custom server origin', () => {
        expect(resolveWebappUrlFromServerUrl('https://stack.example.test/api'))
            .toBe('https://stack.example.test');
    });
});
