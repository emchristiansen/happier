import { execFile } from 'node:child_process';

import { sessionLaunchScopeUnitName, type SessionLaunchId } from './sessionLaunchId';

// systemd places a dashed slice under its prefix slice: happier-jobs.slice lives in happier.slice.
export const HAPPIER_SLICE_NAME = 'happier.slice';
export const HAPPIER_JOBS_SLICE_NAME = 'happier-jobs.slice';
export const HAPPIER_CRITICAL_SLICE_NAME = 'happier-critical.slice';
export const HAPPIER_CRITICAL_SLICE_MEMORY_LOW_BYTES = 4 * 1024 * 1024 * 1024;

const HAPPIER_JOBS_SLICE_CPU_WEIGHT = '50';
const HAPPIER_JOBS_SLICE_IO_WEIGHT = '50';
const SYSTEMD_USER_RESOURCE_GOVERNOR_PROBE_TIMEOUT_MS = 1_000;
const HAPPIER_JOBS_SLICE_EXPECTED_PROPERTIES: readonly (readonly [string, string])[] = [
  ['CPUWeight', HAPPIER_JOBS_SLICE_CPU_WEIGHT],
  ['IOWeight', HAPPIER_JOBS_SLICE_IO_WEIGHT],
];
const HAPPIER_CRITICAL_SLICE_EXPECTED_PROPERTIES: readonly (readonly [string, string])[] = [
  ['MemoryLow', String(HAPPIER_CRITICAL_SLICE_MEMORY_LOW_BYTES)],
];

export type SystemdUserScopedLaunchSpec = Readonly<{
  filePath: string;
  args: string[];
  env?: Record<string, string>;
}>;

export function shouldUseSystemdUserSessionResourceGovernor(params: Readonly<{
  platform: NodeJS.Platform;
  startupSource: string | undefined;
}>): boolean {
  // Startup source describes lifecycle ownership, not resource policy. Stack/TUI-managed
  // Linux daemons are intentionally labelled "manual" and need the same session isolation.
  return params.platform === 'linux';
}

export type SystemdUserResourceGovernorExecFile = (
  command: string,
  args: readonly string[],
  options: Readonly<{
    timeout: number;
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
  }>,
) => Promise<Readonly<{ stdout: string | Buffer; stderr: string | Buffer }>>;

const defaultExecFile: SystemdUserResourceGovernorExecFile = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, [...args], {
    timeout: options.timeout,
    env: options.env,
    maxBuffer: options.maxBuffer,
  }, (error, stdout, stderr) => {
    if (error) {
      reject(error);
      return;
    }
    resolve({ stdout, stderr });
  });
});

function hasSystemdUserBus(environment: NodeJS.ProcessEnv): boolean {
  return String(environment.DBUS_SESSION_BUS_ADDRESS ?? '').trim().length > 0;
}

function parseSystemdProperties(raw: string): ReadonlyMap<string, string> {
  const properties = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const delimiter = line.indexOf('=');
    if (delimiter <= 0) continue;
    properties.set(line.slice(0, delimiter).trim(), line.slice(delimiter + 1).trim());
  }
  return properties;
}

type SystemdUserSlicePolicy = Readonly<{
  sliceName: string;
  expectedProperties: readonly (readonly [string, string])[];
  requiredFiniteProperties?: readonly string[];
}>;

function isFinitePositiveSystemdLimit(value: string | undefined): boolean {
  if (!value || value === 'infinity') return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

/**
 * Why a slice can or cannot take a session scope. Every "not ready" answer
 * names its reason, so a launch that stays in the daemon's cgroup can say why.
 */
export type SystemdUserSliceProbeResult =
  | Readonly<{ kind: 'ready' }>
  | SystemdUserSliceProbeFailure;

export type SystemdUserSliceProbeFailure =
  | Readonly<{ kind: 'unsupported-platform'; platform: NodeJS.Platform }>
  | Readonly<{ kind: 'no-user-bus' }>
  | Readonly<{ kind: 'slice-mismatch'; property: string; expected: string; actual: string }>
  | Readonly<{ kind: 'probe-error'; message: string }>
  | Readonly<{ kind: 'probe-timeout' }>;

const POSITIVE_FINITE_EXPECTATION = 'positive-finite';

function findSlicePolicyMismatch(
  properties: ReadonlyMap<string, string>,
  policy: SystemdUserSlicePolicy,
): SystemdUserSliceProbeFailure | null {
  const requiredFiniteProperties = policy.requiredFiniteProperties ?? [];
  const expectations: readonly (readonly [string, string])[] = [
    ['LoadState', 'loaded'],
    ...policy.expectedProperties,
  ];
  for (const [property, expected] of expectations) {
    const actual = properties.get(property) ?? '';
    if (actual !== expected) return { kind: 'slice-mismatch', property, expected, actual };
  }
  for (const property of requiredFiniteProperties) {
    const actual = properties.get(property) ?? '';
    if (!isFinitePositiveSystemdLimit(actual)) {
      return { kind: 'slice-mismatch', property, expected: POSITIVE_FINITE_EXPECTATION, actual };
    }
  }
  return null;
}

function isExecFileTimeout(error: unknown): boolean {
  // child_process.execFile kills the child when `timeout` elapses and reports `killed: true`.
  return typeof error === 'object' && error !== null && (error as { killed?: unknown }).killed === true;
}

async function probeSystemdUserSlice(
  params: Readonly<{
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    execFile?: SystemdUserResourceGovernorExecFile;
  }>,
  policy: SystemdUserSlicePolicy,
): Promise<SystemdUserSliceProbeResult> {
  const platform = params.platform ?? process.platform;
  const environment = params.environment ?? process.env;
  if (platform !== 'linux') {
    return { kind: 'unsupported-platform', platform };
  }
  if (!hasSystemdUserBus(environment)) {
    return { kind: 'no-user-bus' };
  }

  let stdout: string;
  try {
    const runExecFile = params.execFile ?? defaultExecFile;
    const requiredFiniteProperties = policy.requiredFiniteProperties ?? [];
    const result = await runExecFile('systemctl', [
      '--user',
      'show',
      policy.sliceName,
      '--property=LoadState',
      ...policy.expectedProperties.map(([property]) => `--property=${property}`),
      ...requiredFiniteProperties.map((property) => `--property=${property}`),
    ], {
      timeout: SYSTEMD_USER_RESOURCE_GOVERNOR_PROBE_TIMEOUT_MS,
      env: environment,
      maxBuffer: 16 * 1024,
    });
    stdout = String(result.stdout);
  } catch (error) {
    if (isExecFileTimeout(error)) return { kind: 'probe-timeout' };
    return { kind: 'probe-error', message: error instanceof Error ? error.message : String(error) };
  }

  return findSlicePolicyMismatch(parseSystemdProperties(stdout), policy) ?? { kind: 'ready' };
}

function buildSystemdUserScopedLaunchSpecForSlice(
  params: Readonly<{ launchSpec: SystemdUserScopedLaunchSpec }>,
  sliceName: string,
  scopeArgs: readonly string[],
): SystemdUserScopedLaunchSpec {
  return {
    filePath: 'systemd-run',
    args: [
      '--user',
      '--scope',
      '--quiet',
      `--slice=${sliceName}`,
      ...scopeArgs,
      // systemd-run expands ${VAR} in the command line by default, and with --scope it
      // does so itself before exec. Runner argv (resume paths, model ids) must arrive literally.
      '--expand-environment=no',
      '--',
      params.launchSpec.filePath,
      ...params.launchSpec.args,
    ],
    ...(params.launchSpec.env ? { env: params.launchSpec.env } : {}),
  };
}

/**
 * Checking the expected jobs policy keeps an arbitrary Linux host on its
 * existing launch path instead of turning a missing user manager into a
 * session-start failure. The result names why a host is not ready, so the
 * unscoped launch that follows can be logged with its reason.
 */
export async function probeSystemdUserResourceGovernor(params: Readonly<{
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  execFile?: SystemdUserResourceGovernorExecFile;
}> = {}): Promise<SystemdUserSliceProbeResult> {
  return await probeSystemdUserSlice(params, {
    sliceName: HAPPIER_JOBS_SLICE_NAME,
    expectedProperties: HAPPIER_JOBS_SLICE_EXPECTED_PROPERTIES,
    requiredFiniteProperties: ['MemoryHigh'],
  });
}

/**
 * Wraps one session launch attempt in its own transient user scope,
 * `happier-launch-<launchId>.scope`, inside `happier-jobs.slice`. The unit name
 * comes from the attempt, not the session, so a respawned runner never collides
 * with an older scope that still holds processes.
 */
export function buildSystemdUserScopedLaunchSpec(params: Readonly<{
  launchSpec: SystemdUserScopedLaunchSpec;
  launchId: SessionLaunchId;
}>): SystemdUserScopedLaunchSpec {
  return buildSystemdUserScopedLaunchSpecForSlice(params, HAPPIER_JOBS_SLICE_NAME, [
    `--unit=${sessionLaunchScopeUnitName(params.launchId)}`,
    '--nice=10',
  ]);
}

/**
 * A managed guest must have this exact reservation before a detached daemon
 * joins the critical slice; otherwise the existing direct launch remains the
 * safe fallback.
 */
export async function isSystemdUserCriticalResourceGovernorReady(params: Readonly<{
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  execFile?: SystemdUserResourceGovernorExecFile;
}> = {}): Promise<boolean> {
  const probe = await probeSystemdUserSlice(params, {
    sliceName: HAPPIER_CRITICAL_SLICE_NAME,
    expectedProperties: HAPPIER_CRITICAL_SLICE_EXPECTED_PROPERTIES,
  });
  return probe.kind === 'ready';
}

export function buildSystemdUserCriticalScopedLaunchSpec(params: Readonly<{
  launchSpec: SystemdUserScopedLaunchSpec;
}>): SystemdUserScopedLaunchSpec {
  return buildSystemdUserScopedLaunchSpecForSlice(params, HAPPIER_CRITICAL_SLICE_NAME, []);
}
