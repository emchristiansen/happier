import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline npm release script supports dev channel prerelease versions in dry-run', async () => {
    const out = execFileSync(
        process.execPath,
        [
            resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'release-packages.mjs'),
            '--channel',
            'dev',
            '--publish-cli',
            'true',
            '--publish-stack',
            'false',
            '--publish-server',
            'false',
            '--dry-run',
        ],
        {
            cwd: repoRoot,
            env: {
                ...process.env,
                HAPPIER_RELEASE_PUBLISHED_VERSIONS_JSON: JSON.stringify({ github: {}, npm: {} }),
            },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 30_000,
        },
    );

    assert.match(out, /version: [\d.]+ -> [\d.]+-dev\./);
        assert.match(out, /publish-tarball\.mjs --channel dev/);
});
