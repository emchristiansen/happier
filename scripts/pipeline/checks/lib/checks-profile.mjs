// @ts-check

// Source-check selection lives here for both local execution and hosted dispatch.
// Local profiles retain their existing toolchain coverage; hosted profiles also
// select platform jobs. Release artifact validation has a separate owner.
const baseline = ['unit', 'integration', 'typecheck', 'release_contracts'];
const sharedChecks = [
  'ui_e2e', 'e2e_core', 'e2e_core_slow', 'server_db_contract', 'stress',
  'self_host_systemd', 'self_host_launchd', 'self_host_schtasks', 'self_host_daemon',
];
const localChecks = [...baseline, ...sharedChecks, 'build_website', 'build_docs', 'cli_smoke_linux', 'release_assets_e2e'];
const hostedFast = ['ui', 'shared_packages', 'server', 'cli', 'stack', 'typecheck', 'e2e_core'];
const hostedRelease = [...hostedFast, 'ui_e2e', 'daemon_e2e', 'server_db_contract', 'release_contracts', 'installers_smoke', 'binary_smoke', 'build_smoke'];
const hostedDeep = [...hostedRelease, ...sharedChecks, 'wsrepl_lima', 'mobile_e2e_android', 'mobile_e2e_ios', 'daemon_continuity', 'session_continuity', 'release_assets_docker', 'extended_db'];
const hostedChecks = [...new Set([...hostedDeep, 'providers', 'cli_update_continuity'])];

/** @type {Record<'local'|'hosted', Record<string, string[]>>} */
const profiles = {
  local: {
    none: [],
    fast: [...baseline, 'ui_e2e'],
    full: [...baseline, 'ui_e2e', 'e2e_core_slow', 'server_db_contract', 'build_website', 'build_docs', 'cli_smoke_linux'],
    'release-assets': [...baseline, 'release_assets_e2e'],
  },
  hosted: { fast: hostedFast, release: hostedRelease, deep: hostedDeep },
};

/**
 * @param {{ profile: string; customChecks: string; target?: 'local'|'hosted'; uiE2eSpecs?: string }} input
 * @returns {Set<string>}
 */
function resolveSelection({ profile, customChecks, target = 'local', uiE2eSpecs = '' }) {
  const errors = [];
  const allowed = target === 'local' ? localChecks : hostedChecks;
  const defaults = profiles[target];
  if (profile !== 'custom' && !Object.hasOwn(defaults, profile)) errors.push('unsupported profile: ' + profile);
  const tokens = profile === 'custom'
    ? customChecks.split(',').map((token) => token.trim().toLowerCase())
    : defaults[profile] ?? [];
  if (profile === 'custom') {
    if (!customChecks.trim()) errors.push('profile=custom requires custom_checks');
    else if (tokens.some((token) => !token)) errors.push('empty custom_checks token; remove repeated, leading, or trailing commas');
    const unknown = tokens.filter((token) => token && !allowed.includes(token));
    if (unknown.length) errors.push('unknown custom_checks: ' + unknown.join(', '));
  }
  const selected = new Set(tokens.filter(Boolean));
  if (uiE2eSpecs && profile !== 'custom') errors.push('profile=custom is required when ui_e2e_specs is set');
  if (uiE2eSpecs && !selected.has('ui_e2e')) errors.push('custom_checks must include ui_e2e when ui_e2e_specs is set');
  if (/[\r\n]/.test(uiE2eSpecs)) errors.push('ui_e2e_specs must be a single comma-separated line');
  if (errors.length) throw new Error(errors.join('\n'));
  if (selected.has('e2e_core_slow')) selected.add('e2e_core');
  return selected;
}

/** @param {{ profile: string; customChecks: string }} input */
export function resolveChecksProfilePlan(input) {
  const selected = resolveSelection(input);
  return {
    runCi: selected.size > 0,
    runUnit: selected.has('unit'),
    runIntegration: selected.has('integration'),
    runTypecheck: selected.has('typecheck'),
    runReleaseContracts: selected.has('release_contracts'),
    runUiE2e: selected.has('ui_e2e'),
    runE2eCore: selected.has('e2e_core'),
    runE2eCoreSlow: selected.has('e2e_core_slow'),
    runServerDbContract: selected.has('server_db_contract'),
    runStress: selected.has('stress'),
    runBuildWebsite: selected.has('build_website'),
    runBuildDocs: selected.has('build_docs'),
    runCliSmokeLinux: selected.has('cli_smoke_linux'),
    runReleaseAssetsE2e: selected.has('release_assets_e2e'),
    runSelfHostSystemd: selected.has('self_host_systemd'),
    runSelfHostLaunchd: selected.has('self_host_launchd'),
    runSelfHostSchtasks: selected.has('self_host_schtasks'),
    runSelfHostDaemon: selected.has('self_host_daemon'),
  };
}

/** @param {{ profile: string; customChecks: string; uiE2eSpecs?: string }} input */
export function resolveHostedChecksProfilePlan(input) {
  const selected = resolveSelection({ ...input, target: 'hosted' });
  return Object.fromEntries(hostedChecks.map((key) => [
    key === 'daemon_e2e' ? 'run_cli_daemon_e2e' : 'run_' + key,
    selected.has(key),
  ]));
}
