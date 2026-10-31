import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('publish-ui-mobile-dev keeps TestFlight external distribution logic inside the shared pipeline', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'publish-ui-mobile-dev.yml'), 'utf8');

  assert.match(src, /node scripts\/pipeline\/run\.mjs ui-mobile-release/);
  assert.match(src, /--action native_submit/);
  assert.match(src, /APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS:\s*\$\{\{\s*vars\.APP_STORE_CONNECT_PUBLICDEV_EXTERNAL_GROUPS\s*\}\}/);
  assert.doesNotMatch(src, /node scripts\/pipeline\/run\.mjs expo-testflight-distribute/);
  assert.match(src, /--build-json "\/tmp\/eas_build\.ios\.json"/);
  assert.equal(src.match(/--preflight-only/g)?.length, 2);

  const iosCloud = src.slice(src.indexOf('  ios_cloud:'), src.indexOf('  ios_local:'));
  const iosLocal = src.slice(src.indexOf('  ios_local:'));
  for (const job of [iosCloud, iosLocal]) {
    assert.match(job, /name: Checkout trusted TestFlight preflight control bytes/);
    assert.match(job, /repository: \$\{\{ job\.workflow_repository \}\}/);
    assert.match(job, /ref: \$\{\{ job\.workflow_sha \}\}/);
    assert.match(job, /path: \.testflight-preflight-control/);
    assert.match(job, /working-directory: \.testflight-preflight-control/);
    assert.match(job, /node \.testflight-preflight-control\/scripts\/pipeline\/run\.mjs ui-mobile-release/);
    assert.match(job, /HAPPIER_PIPELINE_REPO_ROOT:\s*\$\{\{ github\.workspace \}\}/);
    assert.match(job, /--testflight-distribution-mode deferred/);
    assert.match(job, /dispatch-testflight-reconciliation\.mjs/);
  }
  const workflow = YAML.parse(src);
  for (const job of [workflow.jobs.ios_cloud, workflow.jobs.ios_local]) {
    assert.equal(job.permissions.actions, 'write');
    const dispatch = job.steps.find((step) => step.run?.includes('dispatch-testflight-reconciliation.mjs'));
    const submit = job.steps.find((step) => step.run?.includes('--testflight-distribution-mode deferred'));
    assert.notEqual(submit['continue-on-error'], true);
    assert.equal(dispatch.if, undefined, 'dispatch keeps the default success gate after submission');
    assert.ok(job.steps.indexOf(dispatch) > job.steps.indexOf(submit));
    assert.equal(dispatch.env.GH_TOKEN, '${{ github.token }}');
    assert.match(dispatch.run, /--source-sha "\$\(git rev-parse HEAD\)"/);
    assert.match(dispatch.run, /--build-json "\/tmp\/eas_build\.ios\.json"/);
  }
});
