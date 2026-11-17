import { createServer, type Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reloadConfiguration } from '@/configuration';
import type { Credentials } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { fetchArtifactRecord, isArtifactRecordId, updateArtifactRecord } from './artifactRecords';

// The shared owner behind prompt-doc, approvals and prompt stacks. A loopback server stands in for the Happier API
// and logs every request on every path, so these tests prove which requests leave the client.

const CREDENTIALS: Credentials = { token: 'synthetic-token', encryption: null };
const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID'] as const;
let envScope = createEnvKeyScope(envKeys);
let home = '';
let server: Server;
let requests: string[] = [];
let respond: (method: string, url: string) => Readonly<{ status: number; headers?: Record<string, string>; json?: unknown }>;

beforeEach(async () => {
  requests = [];
  home = await createTempDir('happier-artifact-records-');
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      const response = respond(req.method ?? '', req.url ?? '');
      res.writeHead(response.status, { 'content-type': 'application/json', ...response.headers });
      res.end(JSON.stringify(response.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no address');
  const url = `http://127.0.0.1:${address.port}`;
  envScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url, HAPPIER_ACTIVE_SERVER_ID: undefined });
  reloadConfiguration();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  reloadConfiguration();
  await removeTempDir(home);
});

describe('artifact record selector', () => {
  it('accepts opaque server ids and refuses values that cannot name exactly one artifact', () => {
    for (const id of ['19d69028-d944-42a5-bddb-733db6760f1c', 'prompt-doc-under-test', 'a/b', '...', '%2e%2e']) {
      expect(isArtifactRecordId(id)).toBe(true);
    }
    for (const id of ['', '.', '..', ' id', 'id\n', 'a\u0000b']) {
      expect(isArtifactRecordId(id)).toBe(false);
    }
  });

  it.each(['..', '.', ''])('sends no GET or POST for %j', async (artifactId) => {
    respond = () => ({ status: 200 });

    expect(await fetchArtifactRecord({ credentials: CREDENTIALS, artifactId })).toEqual({ ok: false, error: { code: 'invalid_artifact_id' } });
    expect(await updateArtifactRecord({ credentials: CREDENTIALS, artifactId, request: { body: 'x', expectedBodyVersion: 1 } }))
      .toEqual({ ok: false, error: { code: 'invalid_artifact_id' } });
    expect(requests).toEqual([]);
  });

  it('keeps an encoded slash or percent inside the one selected path segment', async () => {
    respond = () => ({ status: 404 });

    await fetchArtifactRecord({ credentials: CREDENTIALS, artifactId: 'a/../b' });
    await fetchArtifactRecord({ credentials: CREDENTIALS, artifactId: '%2e%2e' });

    expect(requests).toEqual(['GET /v1/artifacts/a%2F..%2Fb', 'GET /v1/artifacts/%252e%252e']);
  });
});

describe('artifact record redirects', () => {
  const redirectTo = (status: number) => (_method: string, url: string) => (url === '/v1/artifacts/a1'
    ? { status, headers: { location: '/v1/account/settings' } }
    : { status: 200, json: { success: true, bodyVersion: 2 } });

  it.each([301, 302, 303, 307, 308])('reports a GET %i as its own status without a second request', async (status) => {
    respond = redirectTo(status);

    expect(await fetchArtifactRecord({ credentials: CREDENTIALS, artifactId: 'a1' })).toEqual({ ok: false, error: { code: 'http_status', status } });
    expect(requests).toEqual(['GET /v1/artifacts/a1']);
  });

  it.each([307, 308])('reports a POST %i as its own status without forwarding the body', async (status) => {
    respond = redirectTo(status);

    expect(await updateArtifactRecord({ credentials: CREDENTIALS, artifactId: 'a1', request: { body: 'x', expectedBodyVersion: 1 } }))
      .toEqual({ ok: false, error: { code: 'http_status', status } });
    expect(requests).toEqual(['POST /v1/artifacts/a1']);
  });
});
