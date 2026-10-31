import { describe, expect, it } from 'vitest';

import { parseCliArgs } from './parseArgs';

describe('parseCliArgs', () => {
    it('leaves provider-owned runtime-context arguments after the command untouched', () => {
        expect(parseCliArgs(['claude', '--runtime-context', 'provider-value']).args)
            .toEqual(['claude', '--runtime-context', 'provider-value']);
    });

    it('strips a leading packaged runtime entrypoint before parsing command args', () => {
        expect(
            parseCliArgs([
                '/Users/test/.happier/stacks/review-runs/runtime/builds/abc123/cli/package-dist/index.mjs',
                'daemon',
                'start-sync',
            ]),
        ).toEqual({
            args: ['daemon', 'start-sync'],
            terminalRuntime: null,
        });
    });
});
