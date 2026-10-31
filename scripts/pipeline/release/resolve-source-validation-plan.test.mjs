import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveSourceValidationPlan } from './resolve-source-validation-plan.mjs';

const base = {
  deployTargets: [],
  forceDeploy: false,
  changed: { ui: false, cli: false, server: false, shared: false },
  resume: { cli: false, stack: false, server: false },
  risks: { mysqlContract: false, platformServices: false, trustRoots: false },
};

test('selects no expensive source gates when the unioned change has no matching risk', () => {
  assert.deepEqual(resolveSourceValidationPlan(base), {
    runMysql: false,
    runPlatform: false,
    runTrustRoots: false,
  });
});

test('selects the union of channel-relevant source risks once', () => {
  assert.deepEqual(resolveSourceValidationPlan({
    ...base,
    deployTargets: ['cli', 'stack'],
    changed: { ...base.changed, server: true },
    risks: { mysqlContract: true, platformServices: true, trustRoots: true },
  }), {
    runMysql: true,
    runPlatform: true,
    runTrustRoots: true,
  });
});

test('does not run service gates for risky paths when no affected binary or runtime is being published', () => {
  assert.deepEqual(resolveSourceValidationPlan({
    ...base,
    risks: { mysqlContract: true, platformServices: true, trustRoots: false },
  }), {
    runMysql: false,
    runPlatform: false,
    runTrustRoots: false,
  });
});

test('resume and force inputs preserve validation for reused publish surfaces', () => {
  assert.deepEqual(resolveSourceValidationPlan({
    ...base,
    resume: { ...base.resume, server: true },
    risks: { ...base.risks, mysqlContract: true },
  }), {
    runMysql: true,
    runPlatform: false,
    runTrustRoots: false,
  });

  assert.deepEqual(resolveSourceValidationPlan({
    ...base,
    forceDeploy: true,
    risks: { ...base.risks, platformServices: true },
  }), {
    runMysql: false,
    runPlatform: true,
    runTrustRoots: false,
  });
});
