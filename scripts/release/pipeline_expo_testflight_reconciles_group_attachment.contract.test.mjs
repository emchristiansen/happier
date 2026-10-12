import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const groupId = '78315e16-c539-43ae-a65e-4f465dccaf68';

for (const outcome of ['recovered', 'already-attached', 'group-absent', 'persistent-error']) {
test(`TestFlight distribution reconciles a group attachment 404: ${outcome}`, () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-testflight-attachment-retry-'));
  const preloadPath = path.join(fixtureRoot, 'mock-asc.mjs');
  const requestsPath = path.join(fixtureRoot, 'requests.jsonl');
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

  fs.writeFileSync(
    preloadPath,
    `import fs from 'node:fs';
let groupReads = 0;

globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(url);
  const pathname = parsed.pathname;
  const method = String(init.method ?? 'GET');
  fs.appendFileSync(process.env.HAPPIER_TEST_ASC_REQUESTS_PATH, JSON.stringify({ method, pathname }) + '\\n');

  if (pathname === '/v1/apps/6761304097/betaGroups') {
    groupReads += 1;
    if ('${outcome}' === 'group-absent' && groupReads > 1) return Response.json({ data: [] });
    return Response.json({
      data: [{
        type: 'betaGroups',
        id: '${groupId}',
        attributes: { name: 'Happier (dev)', isInternalGroup: false },
      }],
    });
  }
  if (pathname === '/v1/builds' && method === 'GET') {
    return Response.json({
      data: [{
        type: 'builds',
        id: 'build-1',
        attributes: { version: '305', uploadedDate: '2026-09-22T14:11:00Z', processingState: 'VALID' },
        relationships: {
          preReleaseVersion: { data: { type: 'preReleaseVersions', id: 'version-1' } },
          betaGroups: { data: [] },
        },
      }],
      included: [{ type: 'preReleaseVersions', id: 'version-1', attributes: { version: '0.2.12' } }],
    });
  }
  if (pathname === '/v1/builds/build-1' && method === 'GET') {
    return Response.json({ data: { type: 'builds', id: 'build-1', relationships: { betaGroups: {
      data: '${outcome}' === 'already-attached' ? [{ type: 'betaGroups', id: '${groupId}' }] : [],
    } } } });
  }
  if (pathname === '/v1/betaGroups/${groupId}/relationships/builds' && method === 'POST') {
    return Response.json({
      errors: [{ status: '404', code: 'NOT_FOUND', title: 'The specified resource does not exist' }],
    }, { status: 404 });
  }
  if (pathname === '/v1/builds/build-1/relationships/betaGroups' && method === 'POST') {
    if ('${outcome}' === 'persistent-error') return Response.json({ errors: [{ code: 'NOT_FOUND' }] }, { status: 404 });
    return Response.json({});
  }
  return Response.json({ errors: [{ code: 'UNEXPECTED_TEST_URL', detail: method + ' ' + pathname }] }, { status: 500 });
};
`,
  );

  try {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        preloadPath,
        'scripts/pipeline/expo/testflight-distribute.mjs',
        '--environment=dev',
        `--external-groups=${groupId}`,
        '--build-number=305',
        '--app-version=0.2.12',
        '--wait-processing=false',
        '--submit-beta-review=false',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          APPLE_API_PRIVATE_KEY: privateKeyPem,
          HAPPIER_TEST_ASC_REQUESTS_PATH: requestsPath,
          HAPPIER_TESTFLIGHT_ATTACHMENT_RETRY_DELAY_MS: '0',
        },
      },
    );

    assert.equal(result.status, ['group-absent', 'persistent-error'].includes(outcome) ? 1 : 0, `${result.stdout}\n${result.stderr}`);
    const requests = fs.readFileSync(requestsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(requests.filter(({ method, pathname }) => method === 'POST' && pathname.endsWith('/relationships/builds')).length, 1);
    assert.equal(requests.filter(({ method, pathname }) => method === 'POST' && pathname.endsWith('/relationships/betaGroups')).length,
      outcome === 'recovered' ? 1 : outcome === 'persistent-error' ? 4 : 0);
    assert.ok(requests.some(({ method, pathname }) => method === 'GET' && pathname === '/v1/builds/build-1'));
    if (outcome !== 'already-attached') {
      assert.ok(requests.filter(({ method, pathname }) => method === 'GET' && pathname === '/v1/apps/6761304097/betaGroups').length >= 2);
    }
    if (outcome === 'recovered') assert.match(result.stdout, /retrying TestFlight group attachment through build relationship after state reconciliation/i);
    if (outcome === 'group-absent') assert.match(result.stderr, /POST.*betaGroups\/.*relationships\/builds failed \(404\)/);
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
}
