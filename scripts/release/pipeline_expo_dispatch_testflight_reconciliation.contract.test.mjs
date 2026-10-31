import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const easBuildId = '123e4567-e89b-12d3-a456-426614174000';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-testflight-dispatch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const commands = path.join(dir, 'commands.jsonl');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  // GitHub is the external process boundary; request parsing and identity extraction stay real.
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
require('node:fs').appendFileSync(process.env.TEST_GH_COMMANDS, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(Number(process.env.TEST_GH_EXIT || 0));
`, { mode: 0o755 });
  const buildJson = path.join(dir, 'build.json');
  return {
    dir, buildJson,
    run(build, env = {}) {
      fs.writeFileSync(buildJson, JSON.stringify(build));
      return spawnSync(process.execPath, [
        path.join(repoRoot, 'scripts/pipeline/expo/dispatch-testflight-reconciliation.mjs'),
        '--repository', 'happier-dev/happier', '--workflow-ref', 'dev', '--source-sha', 'a'.repeat(40),
        '--environment', 'dev', '--profile', 'dev', '--build-json', buildJson,
      ], {
        cwd: repoRoot, encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS: 'configured-group', TEST_GH_COMMANDS: commands, ...env },
      });
    },
    requests() {
      return fs.existsSync(commands) ? fs.readFileSync(commands, 'utf8').trim().split('\n').map(JSON.parse) : [];
    },
  };
}

test('dispatches exact cloud identity through the existing recovery workflow, without waiting for Apple', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const result = f.run([{ id: 'android-build', platform: 'ANDROID' }, { id: easBuildId, platform: 'IOS' }]);
  assert.equal(result.status, 0, result.stderr);
  const [args] = f.requests();
  assert.deepEqual(args.slice(0, 7), ['workflow', 'run', 'build-ui-mobile-local.yml', '--repo', 'happier-dev/happier', '--ref', 'dev']);
  assert.ok(args.includes('action=retry_testflight_distribution'));
  assert.ok(args.includes('profile=dev'), 'workflow inputs use the public profile choice, not its internal EAS alias');
  assert.ok(args.includes(`source_ref=${'a'.repeat(40)}`));
  assert.ok(args.includes(`retry_testflight_eas_build_id=${easBuildId}`));
  assert.equal(f.requests().length, 1);
});

test('dispatches the actual local IPA identity without an EAS build id or a second build', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const app = path.join(f.dir, 'Payload', 'Happier.app');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.happier.dev</string>
<key>CFBundleShortVersionString</key><string>0.2.12</string>
<key>CFBundleVersion</key><string>305</string>
</dict></plist>`);
  const ipa = path.join(f.dir, 'candidate.ipa');
  execFileSync('zip', ['-qr', ipa, 'Payload'], { cwd: f.dir });
  const result = f.run({ mode: 'local', platform: 'ios', profile: 'publicdev', artifactPath: ipa });
  assert.equal(result.status, 0, result.stderr);
  const [args] = f.requests();
  assert.ok(args.includes('retry_testflight_build_number=305'));
  assert.ok(args.includes('retry_testflight_app_version=0.2.12'));
  assert.ok(!args.some((arg) => arg.startsWith('retry_testflight_eas_build_id=')));
});

test('skipped builds and unconfigured external distribution never dispatch', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  assert.equal(f.run({ skipped: true, reason: 'fingerprint unchanged' }).status, 0);
  assert.equal(f.run({ id: easBuildId, platform: 'ios' }, { APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS: '' }).status, 0);
  assert.deepEqual(f.requests(), []);
});

test('missing build identity and failed dispatch remain visible failures', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  assert.notEqual(f.run({ platform: 'ios' }).status, 0);
  assert.deepEqual(f.requests(), []);
  assert.notEqual(f.run({ id: easBuildId, platform: 'ios' }, { TEST_GH_EXIT: '7' }).status, 0);
  assert.equal(f.requests().length, 1);
});
