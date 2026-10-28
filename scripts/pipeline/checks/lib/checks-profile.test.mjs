import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveChecksProfilePlan } from './checks-profile.mjs';

test('resolveChecksProfilePlan keeps self-host checks disabled by default', () => {
  const plan = resolveChecksProfilePlan({ profile: 'full', customChecks: '' });
  assert.equal(plan.runSelfHostLaunchd, false);
  assert.equal(plan.runSelfHostSystemd, false);
  assert.equal(plan.runSelfHostSchtasks, false);
  assert.equal(plan.runSelfHostDaemon, false);
});

test('resolveChecksProfilePlan enables self-host checks via custom toggles', () => {
  const plan = resolveChecksProfilePlan({
    profile: 'custom',
    customChecks: 'self_host_launchd,self_host_systemd,self_host_schtasks,self_host_daemon',
  });
  assert.equal(plan.runSelfHostLaunchd, true);
  assert.equal(plan.runSelfHostSystemd, true);
  assert.equal(plan.runSelfHostSchtasks, true);
  assert.equal(plan.runSelfHostDaemon, true);
});

test('custom checks select only named baseline and optional lanes', () => {
  const plan = resolveChecksProfilePlan({ profile: 'custom', customChecks: 'typecheck,build_docs' });
  assert.equal(plan.runTypecheck, true);
  assert.equal(plan.runBuildDocs, true);
  assert.equal(plan.runUnit, false);
  assert.equal(plan.runIntegration, false);
  assert.equal(plan.runReleaseContracts, false);
  assert.equal(plan.runUiE2e, false);
});

test('custom checks reject empty and unknown selections before executing any work', () => {
  for (const customChecks of ['', 'unit,,typecheck', 'not_a_check', 'mobile_e2e_android']) {
    assert.throws(() => resolveChecksProfilePlan({ profile: 'custom', customChecks }), /custom_checks/);
  }
});
