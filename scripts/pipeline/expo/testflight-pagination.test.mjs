import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('TestFlight recovery distributes the matching valid build from a later API page', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'testflight-pagination-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const preload = path.join(directory, 'asc.mjs');
  const marker = path.join(directory, 'attachment.json');
  fs.writeFileSync(preload, `
    import fs from 'node:fs';
    globalThis.fetch = async (url, init = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/betaGroups')) return Response.json({ data: [{
        id: 'group-1', type: 'betaGroups', attributes: { name: 'Public Beta', isInternalGroup: false },
      }] });
      if (parsed.pathname === '/v1/builds') {
        if (!parsed.searchParams.has('cursor')) return Response.json({ data: [], links: {
          next: 'https://api.appstoreconnect.apple.com/v1/builds?cursor=page-two',
        } });
        return Response.json({ data: [{ id: 'older-build', type: 'builds',
          attributes: { version: '305', processingState: 'VALID', uploadedDate: '2026-09-22T14:11:00Z' },
          relationships: { preReleaseVersion: { data: { id: 'train-1', type: 'preReleaseVersions' } }, betaGroups: { data: [] } },
        }], included: [{ id: 'train-1', type: 'preReleaseVersions', attributes: { version: '0.2.12' } }] });
      }
      if (parsed.pathname === '/v1/betaGroups/group-1/relationships/builds' && init.method === 'POST') {
        fs.writeFileSync(${JSON.stringify(marker)}, init.body);
        return Response.json({});
      }
      throw new Error('Unexpected ASC boundary request: ' + url);
    };
  `);
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const result = spawnSync(process.execPath, ['--import', preload,
    'scripts/pipeline/expo/testflight-distribute.mjs', '--environment=dev', '--external-groups=Public Beta',
    '--build-number=305', '--app-version=0.2.12', '--wait-processing=false', '--submit-beta-review=false',
  ], {
    cwd: path.resolve(import.meta.dirname, '../../..'), encoding: 'utf8',
    env: { ...process.env, APPLE_API_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).data, [{ type: 'builds', id: 'older-build' }]);
});
