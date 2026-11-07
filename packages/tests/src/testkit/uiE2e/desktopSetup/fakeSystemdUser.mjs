// @ts-check
/**
 * Test double for the `systemctl --user` OS boundary, used by the hermetic desktop computer
 * (`hermeticDesktopComputer.ts`). It plays the systemd user manager for exactly the calls the
 * Happier CLI makes on Linux (`packages/cli-common/src/service/manager.ts`,
 * `apps/cli/src/daemon/service/{plan,cli,apply}.ts`): daemon-reload, enable/disable [--now],
 * start/stop/restart, is-active, is-enabled, status and show. It reads the unit file the CLI wrote,
 * runs its `ExecStart=` with its `Environment=` lines and `WorkingDirectory=%h` under a detached
 * supervisor that records the main PID and applies `Restart=on-failure`, and stops with SIGTERM to
 * the main PID only (`KillMode=process`), waiting for it to exit like systemd's stop job.
 *
 * It decides nothing about Happier: every Happier decision stays in the CLI, which only sees the
 * same exit codes and `K=V` output a real user manager gives it.
 *
 * Configuration (baked into the `systemctl` wrapper by the testkit):
 *   FAKE_SYSTEMD_UNIT_DIR   the directory the CLI writes user units to (`~/.config/systemd/user`)
 *   FAKE_SYSTEMD_STATE_DIR  where unit runtime state, logs and the invocation log live
 *   FAKE_SYSTEMD_HOME       `%h`
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const unitDir = requireEnv('FAKE_SYSTEMD_UNIT_DIR');
const stateDir = requireEnv('FAKE_SYSTEMD_STATE_DIR');
const homeDir = requireEnv('FAKE_SYSTEMD_HOME');

const STOP_TIMEOUT_MS = 90_000;

/** @param {string} name */
function requireEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) {
    process.stderr.write(`fake systemctl: ${name} is not configured\n`);
    process.exit(1);
  }
  return value;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {number | null | undefined} pid */
function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A zombie still answers kill(0); systemd would already have reaped it.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z';
  } catch {
    return true;
  }
}

/** @param {string} unit */
function statePath(unit) {
  return join(stateDir, `${unit}.json`);
}

/** @param {string} unit */
function readState(unit) {
  try {
    return JSON.parse(readFileSync(statePath(unit), 'utf8'));
  } catch {
    return { enabled: false, mainPid: null, supervisorPid: null, restarts: 0, result: 'success', execMainStatus: 0 };
  }
}

/** @param {string} unit @param {Record<string, unknown>} patch */
function writeState(unit, patch) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath(unit), JSON.stringify({ ...readState(unit), ...patch }, null, 2));
}

/** @param {string} unit */
function normalizeUnit(unit) {
  return unit.includes('.') ? unit : `${unit}.service`;
}

/** @param {string} unit */
function unitFilePath(unit) {
  return join(unitDir, unit);
}

/**
 * systemd word splitting for ExecStart=/Environment=: whitespace separates words, double or single
 * quotes group (and may start mid-word), C escapes apply inside quotes, then `%h`/`%%` specifiers.
 * @param {string} value
 */
function splitSystemdWords(value) {
  /** @type {string[]} */
  const words = [];
  let current = '';
  let inWord = false;
  /** @type {string | null} */
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    if (quote) {
      if (ch === '\\' && index + 1 < value.length) {
        const next = value[index + 1];
        index += 1;
        current += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
      continue;
    }
    current += ch;
    inWord = true;
  }
  if (inWord) words.push(current);
  return words.map(expandSpecifiers);
}

/** @param {string} value */
function expandSpecifiers(value) {
  return value.replace(/%(.)/g, (_match, specifier) => (specifier === 'h' ? homeDir : specifier === '%' ? '%' : `%${specifier}`));
}

/** @param {string} unit */
function readUnit(unit) {
  const text = readFileSync(unitFilePath(unit), 'utf8');
  /** @type {Record<string, string>} */
  const env = {};
  /** @type {string[]} */
  let execStart = [];
  let workingDirectory = homeDir;
  let restart = 'no';
  let restartSec = 0.1;
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1] ?? '';
      continue;
    }
    if (section !== 'Service') continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === 'Environment') {
      for (const word of splitSystemdWords(value)) {
        const eq = word.indexOf('=');
        if (eq > 0) env[word.slice(0, eq)] = word.slice(eq + 1);
      }
    } else if (key === 'ExecStart') {
      execStart = splitSystemdWords(value);
    } else if (key === 'WorkingDirectory') {
      workingDirectory = expandSpecifiers(value);
    } else if (key === 'Restart') {
      restart = value;
    } else if (key === 'RestartSec') {
      restartSec = Number(value) || 0.1;
    }
  }
  return { env, execStart, workingDirectory, restart, restartSec };
}

/** The manager's own environment: what a systemd user manager hands every unit before Environment=. */
function readManagerEnv() {
  try {
    return JSON.parse(readFileSync(join(stateDir, 'manager-env.json'), 'utf8'));
  } catch {
    return { HOME: homeDir };
  }
}

/** @param {string} unit */
function isActive(unit) {
  return isAlive(readState(unit).mainPid);
}

/** @param {string} unit */
async function startUnit(unit) {
  if (!existsSync(unitFilePath(unit))) {
    process.stderr.write(`Failed to start ${unit}: Unit ${unit} not found.\n`);
    return 5;
  }
  if (isActive(unit)) return 0;
  rmSync(join(stateDir, `${unit}.stop`), { force: true });
  writeState(unit, { mainPid: null, result: 'success', execMainStatus: 0 });
  const logFd = openSync(join(stateDir, `${unit}.log`), 'a');
  const supervisor = spawn(process.execPath, [new URL(import.meta.url).pathname, '__supervise', unit], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  supervisor.unref();
  // Type=simple: the start job completes once the main process is forked.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { mainPid } = readState(unit);
    if (mainPid) return 0;
    if (!isAlive(supervisor.pid)) break;
    await sleep(25);
  }
  process.stderr.write(`Job for ${unit} failed because the control process exited with error code.\n`);
  return 1;
}

/** @param {string} unit */
async function stopUnit(unit) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `${unit}.stop`), '');
  const { mainPid, supervisorPid } = readState(unit);
  if (isAlive(mainPid)) {
    try {
      process.kill(mainPid, 'SIGTERM');
    } catch {
      // Already gone.
    }
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (isAlive(mainPid) && Date.now() < deadline) await sleep(50);
    if (isAlive(mainPid)) {
      try {
        process.kill(mainPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  const supervisorDeadline = Date.now() + 5_000;
  while (isAlive(supervisorPid) && Date.now() < supervisorDeadline) await sleep(25);
  writeState(unit, { mainPid: null, supervisorPid: null });
  return 0;
}

/** Runs in the detached supervisor process: the unit's lifetime, with Restart=on-failure. */
/** @param {string} unit */
async function supervise(unit) {
  writeState(unit, { supervisorPid: process.pid });
  for (;;) {
    const spec = readUnit(unit);
    const [command, ...args] = spec.execStart;
    if (!command) {
      writeState(unit, { mainPid: null, result: 'exit-code', execMainStatus: 203 });
      return;
    }
    const child = spawn(command, args, {
      cwd: spec.workingDirectory,
      env: { ...readManagerEnv(), ...spec.env },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    writeState(unit, { mainPid: child.pid ?? null });
    const code = await new Promise((resolve) => {
      child.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1)));
      child.on('error', () => resolve(203));
    });
    const stopped = existsSync(join(stateDir, `${unit}.stop`));
    const failed = code !== 0 && !stopped;
    writeState(unit, { mainPid: null, result: failed ? 'exit-code' : 'success', execMainStatus: stopped ? 0 : code });
    if (!failed || !(spec.restart === 'on-failure' || spec.restart === 'always')) return;
    await sleep(spec.restartSec * 1000);
    if (existsSync(join(stateDir, `${unit}.stop`))) return;
    writeState(unit, { restarts: Number(readState(unit).restarts ?? 0) + 1 });
  }
}

/** @param {string} unit @param {string[]} properties @param {boolean} valueOnly */
function show(unit, properties, valueOnly) {
  const loaded = unit.endsWith('.service') && existsSync(unitFilePath(unit));
  const state = readState(unit);
  const active = loaded && isActive(unit);
  /** @type {Record<string, string>} */
  const values = {
    LoadState: loaded ? 'loaded' : 'not-found',
    ActiveState: active ? 'active' : state.result === 'exit-code' ? 'failed' : 'inactive',
    SubState: active ? 'running' : state.result === 'exit-code' ? 'failed' : 'dead',
    MainPID: String(active ? state.mainPid : 0),
    Result: String(state.result ?? 'success'),
    ExecMainStatus: String(state.execMainStatus ?? 0),
    NRestarts: String(state.restarts ?? 0),
    UnitFileState: state.enabled ? 'enabled' : 'disabled',
  };
  const selected = properties.length > 0 ? properties : Object.keys(values);
  for (const property of selected) {
    const value = values[property] ?? '';
    process.stdout.write(valueOnly ? `${value}\n` : `${property}=${value}\n`);
  }
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '__supervise') {
    await supervise(normalizeUnit(argv[1] ?? ''));
    return 0;
  }
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(join(stateDir, 'invocations.log'), `${JSON.stringify(argv)}\n`);
  // Fault: a login session without a user manager (SSH without lingering, most containers). Real
  // systemctl answers every --user call with this; nothing the app can retry fixes it.
  if (existsSync(join(stateDir, 'fault-no-user-bus'))) {
    process.stderr.write('Failed to connect to bus: No medium found\n');
    return 1;
  }

  let now = false;
  let valueOnly = false;
  /** @type {string[]} */
  const properties = [];
  /** @type {string[]} */
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--user' || arg === '--no-pager' || arg === '--quiet' || arg === '-q' || arg === '--no-block') continue;
    if (arg === '--now') {
      now = true;
    } else if (arg === '--value') {
      valueOnly = true;
    } else if (arg.startsWith('--property=')) {
      properties.push(...arg.slice('--property='.length).split(',').filter(Boolean));
    } else if (arg === '-p' || arg === '--property') {
      properties.push(...String(argv[index + 1] ?? '').split(',').filter(Boolean));
      index += 1;
    } else if (arg.startsWith('-')) {
      process.stderr.write(`fake systemctl: unsupported option ${arg}\n`);
      return 1;
    } else {
      positional.push(arg);
    }
  }

  const [verb, ...rawUnits] = positional;
  const units = rawUnits.map(normalizeUnit);
  switch (verb) {
    case 'daemon-reload':
      return 0;
    case 'enable':
    case 'disable': {
      for (const unit of units) {
        if (!existsSync(unitFilePath(unit))) {
          process.stderr.write(`Failed to ${verb} unit: Unit file ${unit} does not exist.\n`);
          return 1;
        }
        writeState(unit, { enabled: verb === 'enable' });
        const code = now ? (verb === 'enable' ? await startUnit(unit) : await stopUnit(unit)) : 0;
        if (code !== 0) return code;
      }
      return 0;
    }
    case 'start':
    case 'stop':
    case 'restart': {
      for (const unit of units) {
        if (verb !== 'start' && !existsSync(unitFilePath(unit)) && !isActive(unit)) {
          process.stderr.write(`Failed to ${verb} ${unit}: Unit ${unit} not loaded.\n`);
          return 5;
        }
        if (verb !== 'start') await stopUnit(unit);
        const code = verb === 'stop' ? 0 : await startUnit(unit);
        if (code !== 0) return code;
      }
      return 0;
    }
    case 'is-active': {
      const active = units.length > 0 && units.every(isActive);
      for (const unit of units) process.stdout.write(`${isActive(unit) ? 'active' : 'inactive'}\n`);
      return active ? 0 : 3;
    }
    case 'is-enabled': {
      const unit = units[0] ?? '';
      if (!existsSync(unitFilePath(unit))) {
        process.stdout.write('not-found\n');
        return 1;
      }
      const enabled = readState(unit).enabled === true;
      process.stdout.write(`${enabled ? 'enabled' : 'disabled'}\n`);
      return enabled ? 0 : 1;
    }
    case 'status': {
      const unit = units[0] ?? '';
      if (!existsSync(unitFilePath(unit))) {
        process.stderr.write(`Unit ${unit} could not be found.\n`);
        return 4;
      }
      const active = isActive(unit);
      process.stdout.write(`● ${unit}\n     Loaded: loaded (${unitFilePath(unit)})\n     Active: ${active ? 'active (running)' : 'inactive (dead)'}\n`);
      if (active) process.stdout.write(`   Main PID: ${readState(unit).mainPid}\n`);
      return active ? 0 : 3;
    }
    case 'show':
      return show(units[0] ?? '', properties, valueOnly);
    default:
      process.stderr.write(`fake systemctl: unsupported command ${String(verb)}\n`);
      return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`fake systemctl: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
