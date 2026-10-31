// @ts-check

import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { resolveChecksProfilePlan, resolveHostedChecksProfilePlan } from './lib/checks-profile.mjs';

/** @param {string} message */
function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * @param {string} outputPath
 * @param {Record<string, string>} values
 */
function writeGithubOutput(outputPath, values) {
  if (!outputPath) return;
  const lines = Object.entries(values).map(([k, v]) => `${k}=${String(v ?? '')}`);
  fs.appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function main() {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string' },
      target: { type: 'string', default: 'local' },
      'custom-checks': { type: 'string', default: '' },
      'github-output': { type: 'string', default: '' },
    },
    allowPositionals: false,
  });

  const hosted = values.target === 'hosted';
  if (!hosted && values.target !== 'local') fail('--target must be local or hosted');
  const profile = String(values.profile ?? (hosted ? process.env.PROFILE : '') ?? '').trim();
  if (!profile) fail('--profile is required (full|fast|none|custom|release-assets)');

  const customChecks = String(values['custom-checks'] || (hosted ? process.env.CUSTOM : '') || '').trim();

  if (hosted) {
    const uiE2eSpecs = process.env.UI_E2E_SPECS ?? '';
    const plan = resolveHostedChecksProfilePlan({ profile, customChecks, uiE2eSpecs });
    writeGithubOutput(values['github-output'] || process.env.GITHUB_OUTPUT || '', {
      ...Object.fromEntries(Object.entries(plan).map(([key, value]) => [key, String(value)])),
      ui_e2e_specs: uiE2eSpecs,
    });
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }

  const plan = resolveChecksProfilePlan({
    profile,
    customChecks,
  });

  writeGithubOutput(String(values['github-output'] ?? '').trim(), {
    run_ci: plan.runCi ? 'true' : 'false',
    run_unit: plan.runUnit ? 'true' : 'false',
    run_integration: plan.runIntegration ? 'true' : 'false',
    run_typecheck: plan.runTypecheck ? 'true' : 'false',
    run_release_contracts: plan.runReleaseContracts ? 'true' : 'false',
    run_ui_e2e: plan.runUiE2e ? 'true' : 'false',
    run_e2e_core: plan.runE2eCore ? 'true' : 'false',
    run_e2e_core_slow: plan.runE2eCoreSlow ? 'true' : 'false',
    run_server_db_contract: plan.runServerDbContract ? 'true' : 'false',
    run_stress: plan.runStress ? 'true' : 'false',
    run_build_website: plan.runBuildWebsite ? 'true' : 'false',
    run_build_docs: plan.runBuildDocs ? 'true' : 'false',
    run_cli_smoke_linux: plan.runCliSmokeLinux ? 'true' : 'false',
    run_release_assets_e2e: plan.runReleaseAssetsE2e ? 'true' : 'false',
  });

  process.stdout.write(`${JSON.stringify({ profile, custom_checks: customChecks, ...plan })}\n`);
}

main();
