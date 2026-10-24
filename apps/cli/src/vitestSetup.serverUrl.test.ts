import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { describe, expect, it } from 'vitest';

import { configuration } from '@/configuration';
import { UNIT_TEST_UNREACHABLE_SERVER_URL } from '@/testkit/env/unitTestServerEnv';

const cliProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const integrationTestEnv = dotenv.parse(readFileSync(resolve(cliProjectRoot, '.env.integration-test'), 'utf8'));

// Origins a unit test must never fall back to: the local server named by the shared test env file
// (a live relay or dev server listens there) and the CLI's production defaults.
const liveDefaultOrigins = [
  integrationTestEnv.HAPPIER_SERVER_URL,
  'http://127.0.0.1:3005',
  'https://api.happier.dev',
  'https://app.happier.dev',
]
  .filter((url): url is string => typeof url === 'string' && url.length > 0)
  .map((url) => new URL(url).origin);

const unreachableOrigin = new URL(UNIT_TEST_UNREACHABLE_SERVER_URL).origin;

// Checks the defaults the unit setup installs (environment values and resolved origins); it makes no
// network connection.
describe('unit test default server URL', () => {
  it('points the default server env at loopback port 9 and clears the overrides', () => {
    expect(process.env.HAPPIER_SERVER_URL).toBe(UNIT_TEST_UNREACHABLE_SERVER_URL);
    expect(process.env.HAPPIER_WEBAPP_URL).toBe(UNIT_TEST_UNREACHABLE_SERVER_URL);
    expect(process.env.HAPPIER_PUBLIC_SERVER_URL).toBeUndefined();
    expect(process.env.HAPPIER_LOCAL_SERVER_URL).toBeUndefined();
  });

  it.each([
    ['serverUrl', () => configuration.serverUrl],
    ['apiServerUrl', () => configuration.apiServerUrl],
    ['webappUrl', () => configuration.webappUrl],
  ] as const)('resolves configuration.%s away from every live default', (_name, read) => {
    const origin = new URL(read()).origin;
    expect(liveDefaultOrigins).not.toContain(origin);
    expect(origin).toBe(unreachableOrigin);
  });
});
