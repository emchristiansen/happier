import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const runScript = join(here, 'run.sh');

for (const scriptName of ['remote-daemon-smoke.sh', 'remote-daemon-authenticated-cli-smoke.sh']) {
  function runSetupCapture(result) {
    const source = fs.readFileSync(join(here, 'bin', scriptName), 'utf8');
    const start = source.indexOf('remote_setup_output="$(mktemp');
    // Exercise the real setup capture at the hstack process boundary, before
    // unrelated relay/SSH connectivity checks.
    const captureEnd = source.indexOf('checking remote daemon connectivity after setup...', start);
    const block = source.slice(start, source.lastIndexOf('\necho ', captureEnd));
    assert.ok(start >= 0 && captureEnd > start);
    return spawnSync('bash', ['-c', `set -euo pipefail
      hstack() { printf '%s\\n' "$HAPPIER_TEST_SETUP_RESULT"; }
      remote_channel_args=(--preview)
      ${block}`, join(here, 'bin', scriptName)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HAPPIER_TEST_SETUP_RESULT: result,
        REMOTE_SSH_TARGET: 'happy@remote1',
        HAPPIER_SERVER_URL: 'http://stack:3005',
        HAPPIER_WEBAPP_URL: 'http://stack:3005',
        HAPPIER_PUBLIC_SERVER_URL: 'http://stack:3005',
      },
    });
  }

  test(`${scriptName} rejects a failed JSON task result even when hstack exits successfully`, () => {
    const output = runSetupCapture([
      JSON.stringify({ protocolVersion: 1, taskId: 'private-task', type: 'progress', data: { token: 'private-token' } }),
      JSON.stringify({ protocolVersion: 1, taskId: 'private-task', ok: false, error: { code: 'DOWNLOAD_FAILED', message: 'Release download failed' } }),
    ].join('\n'));
    assert.equal(output.status, 1, output.stderr);
    assert.match(output.stderr, /DOWNLOAD_FAILED/);
    assert.doesNotMatch(output.stdout + output.stderr, /private-task|private-token/);
  });

  test(`${scriptName} accepts a successful JSON task result without disclosing its data`, () => {
    const output = runSetupCapture(JSON.stringify({ protocolVersion: 1, taskId: 'private-task', ok: true, data: { token: 'private-token' } }));
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stdout + output.stderr, '');
  });

  test(`${scriptName} rejects setup output without a terminal result`, () => {
    const output = runSetupCapture(JSON.stringify({ protocolVersion: 1, taskId: 'private-task', type: 'progress' }));
    assert.equal(output.status, 1, output.stderr);
    assert.match(output.stderr, /REMOTE_SETUP_RESULT_MISSING/);
  });
}

test('npm-e2e-smoke run.sh documents remote daemon flags', () => {
  const res = spawnSync('bash', [runScript, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout ?? '', /--with-remote-daemon/);
  assert.match(res.stdout ?? '', /--no-remote-daemon/);
  assert.match(res.stdout ?? '', /--remote-auth-mode=/);
  assert.match(res.stdout ?? '', /--with-remote-server/);
  assert.match(res.stdout ?? '', /--no-remote-server/);
  assert.match(res.stdout ?? '', /--remote-server-db=/);
});

test('npm-e2e-smoke run.sh supports selecting remote installer mode', () => {
  {
    const res = spawnSync('bash', [runScript, '--remote-installer=shim', '--help'], { encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.match(res.stdout ?? '', /--remote-installer=/);
  }
  {
    const res = spawnSync('bash', [runScript, '--remote-installer=official', '--help'], { encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.match(res.stdout ?? '', /--remote-installer=/);
  }
});

test('npm-e2e-smoke run.sh rejects invalid remote installer mode', () => {
  const res = spawnSync('bash', [runScript, '--remote-installer=wat', '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr ?? '', /remote-installer/i);
});

test('npm-e2e-smoke run.sh rejects unknown args', () => {
  const res = spawnSync('bash', [runScript, '--definitely-not-a-flag'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr ?? '', /Unknown arg/i);
});

test('npm-e2e-smoke run.sh rejects invalid remote auth mode', () => {
  const res = spawnSync('bash', [runScript, '--remote-auth-mode=wat', '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr ?? '', /remote-auth-mode/i);
});

test('npm-e2e-smoke run.sh rejects invalid remote server db mode', () => {
  const res = spawnSync('bash', [runScript, '--remote-server-db=wat', '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stderr ?? '', /remote-server-db/i);
});

test('npm-e2e-smoke run.sh uses consistent compose files when remote daemon enabled', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /\bcompose_run=\(\s*\"\$\{compose_remote\[@\]\}\"\s*\)/);
  assert.match(content, /\$\{compose_run\[@\]\}.*run --rm --no-deps cli/);
  assert.match(content, /\$\{compose_run\[@\]\}.*run --rm --no-deps cli2/);
});

test('npm-e2e-smoke run.sh cleanup does not hang indefinitely', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /cleanup timed out/i);
 });

test('npm-e2e-smoke run.sh does not rebuild when starting remote host', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.doesNotMatch(content, /up -d[^\n]*--build[^\n]*remote1/);
});

test('npm-e2e-smoke run.sh prebuilds remote-daemon-authenticated-cli-smoke', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /build[^\n]*remote-daemon-authenticated-cli-smoke/);
});

test('npm-e2e-smoke run.sh can pack npm tarballs for remote-installer=shim', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /packing remote shim tarballs from npm/i);
  assert.match(content, /\bnpm\b[^\n]*\bpack\b[^\n]*"\$stack_spec"/);
  assert.match(content, /\bnpm\b[^\n]*\bpack\b[^\n]*"\$cli_spec"/);
});

test('npm-e2e-smoke includes remote server smoke scripts and postgres compose', () => {
  const composeRemotePath = join(here, 'compose.remote.yml');
  const composeRemote = fs.readFileSync(composeRemotePath, 'utf8');
  assert.match(composeRemote, /\n  postgres:\n/);
  assert.match(composeRemote, /\n  remote-server1:\n/);
  assert.match(composeRemote, /\n  remote-server-smoke:\n/);
  assert.ok(fs.existsSync(join(here, 'bin', 'remote-server-smoke.sh')));
});

test('npm-e2e-smoke remote smoke scripts pass bash -n', () => {
  const scripts = [
    join(here, 'bin', 'remote-daemon-smoke.sh'),
    join(here, 'bin', 'remote-daemon-authenticated-cli-smoke.sh'),
    join(here, 'bin', 'remote-server-smoke.sh'),
  ];
  for (const script of scripts) {
    const res = spawnSync('bash', ['-n', script], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
  }
});

test('npm-e2e-smoke remote-server-smoke.sh does not use an unterminated heredoc here-string', () => {
  const script = fs.readFileSync(join(here, 'bin', 'remote-server-smoke.sh'), 'utf8');
  assert.doesNotMatch(script, /\nNODE <<</);
});

test('npm-e2e-smoke remote-server-smoke.sh parses multi-line server.env output', () => {
  const script = fs.readFileSync(join(here, 'bin', 'remote-server-smoke.sh'), 'utf8');
  assert.match(script, /const raw = process\.env\.REMOTE_SERVER_CONFIG_ENV_TEXT \|\| '';/);
  assert.match(script, /for \(const line of raw\.split\(\/\\r\?\\n\/\)\)/);
  assert.match(script, /sudo -n cat .*remote_config_env_path/);
});

test('npm-e2e-smoke postgres validation requires both connectivity and applied migrations', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /POSTGRES_APP_NAME=/);
  assert.match(content, /pg_stat_activity/);
  assert.match(content, /application_name/);
  assert.match(content, /_prisma_migrations/);
  assert.match(content, /finished_at/);

  const remoteServerSmoke = fs.readFileSync(join(here, 'bin', 'remote-server-smoke.sh'), 'utf8');
  assert.match(remoteServerSmoke, /application_name=/);
});

test('npm-e2e-smoke run.sh documents docker image smoke flags', () => {
  const res = spawnSync('bash', [runScript, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout ?? '', /--with-docker-images/);
  assert.match(res.stdout ?? '', /--no-docker-images/);
  assert.match(res.stdout ?? '', /--docker-channel=/);
  assert.match(res.stdout ?? '', /--docker-images-db=/);
});

test('release-assets-e2e documents and validates an exact immutable relay upgrade target', () => {
  const help = spawnSync('bash', [runScript, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout ?? '', /--relay-upgrade-to-server-tag=/);
  assert.match(help.stdout ?? '', /--relay-upgrade-to-server-version=/);

  const incomplete = spawnSync('bash', [
    runScript,
    '--relay-upgrade-to-server-tag=server-v0.2.11',
    '--help',
  ], { encoding: 'utf8' });
  assert.equal(incomplete.status, 2);
  assert.match(incomplete.stderr ?? '', /tag and version must be provided together/i);
});

// Exercise the real image-selection prefix, stopping before database/container work.
function createRelayUpgradeImageHarness(t) {
  const source = fs.readFileSync(runScript, 'utf8');
  const start = source.indexOf('run_relay_upgrade_smoke() {');
  const end = source.indexOf('\n  db_cases=()', start);
  assert.ok(start >= 0 && end > start, 'relay upgrade image-selection boundaries must exist');
  const prefix = source.slice(start, end);
  const tmp = mkdtempSync(join(tmpdir(), 'happier-relay-upgrade-image-test-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const image = `happierdev/relay-server:local-upgrade-${sha.slice(0, 12)}`;
  const readArgs = (name) => fs.readFileSync(join(tmp, name), 'utf8').split('\0').slice(0, -1);
  const expectedArgs = (version) => [
    '--tag', image,
    '--build-arg', 'HAPPIER_EMBEDDED_POLICY_ENV=preview',
    '--target', version ? 'relay-server' : 'relay-server-local-source',
    ...(version ? [
      '--build-arg', `HAPPIER_RELAY_SERVER_RELEASE_TAG=server-v${version}`,
      '--build-arg', `HAPPIER_RELAY_SERVER_VERSION=${version}`,
      '--build-arg', `SENTRY_RELEASE=${sha}`,
    ] : []),
    tmp,
  ];
  return {
    image,
    expectedArgs,
    imageArgs: () => readArgs('image'),
    attemptedArgs: () => readArgs('attempt'),
    select(version, failBuild = false) {
      fs.rmSync(join(tmp, 'attempt'), { force: true });
      const result = spawnSync('bash', ['-c', `set -euo pipefail
        repo_root="$TEST_IMAGE_DIR"
        with_relay_upgrade=1
        relay_upgrade_from_channel=preview
        relay_upgrade_to_server_tag="$TEST_RELEASE_TAG"
        relay_upgrade_to_server_version="$TEST_RELEASE_VERSION"
        unexpected_boundary() {
          printf 'unexpected boundary: %s\\n' "$*" >> "$TEST_IMAGE_DIR/errors"
          exit 97
        }
        git() {
          if [[ "$#" == 4 && "$1" == -C && "$2" == "$repo_root" && "$3 $4" == 'rev-parse HEAD' ]]; then
            printf '%s\\n' "$TEST_HEAD"
          else
            unexpected_boundary git "$@"
          fi
        }
        docker() {
          if [[ "$#" == 2 && "$1 $2" == 'pull happierdev/relay-server:preview' ]]; then
            return 0
          elif [[ "$#" == 5 && "$1 $2 $3" == 'image inspect --format' && "$4" == '{{index .RepoDigests 0}}' && "$5" == 'happierdev/relay-server:preview' ]]; then
            printf '%s\\n' 'happierdev/relay-server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
          elif [[ "$#" == 3 && "$1 $2" == 'image inspect' && "$3" == "$TEST_IMAGE_TAG" ]]; then
            [[ -f "$TEST_IMAGE_DIR/image" ]]
          elif [[ "$1" == build ]]; then
            shift
            printf '%s\\0' "$@" > "$TEST_IMAGE_DIR/attempt"
            if [[ "$TEST_FAIL_BUILD" == 1 ]]; then
              printf 'fake docker: build failed\\n' >&2
              return 42
            fi
            printf '%s\\0' "$@" > "$TEST_IMAGE_DIR/image"
          else
            unexpected_boundary docker "$@"
          fi
        }
        ${prefix}
        }
        run_relay_upgrade_smoke
        printf 'selected=%s\\n' "$to_image"
      `], {
        encoding: 'utf8',
        env: {
          ...process.env,
          TEST_IMAGE_DIR: tmp,
          TEST_HEAD: sha,
          TEST_IMAGE_TAG: image,
          TEST_RELEASE_TAG: version ? `server-v${version}` : '',
          TEST_RELEASE_VERSION: version,
          TEST_FAIL_BUILD: failBuild ? '1' : '0',
        },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, result.stderr);
      assert.equal(fs.existsSync(join(tmp, 'errors')), false,
        fs.existsSync(join(tmp, 'errors')) ? fs.readFileSync(join(tmp, 'errors'), 'utf8') : '');
      return result;
    },
  };
}

for (const [label, previous, current] of [
  ['published release changes', '0.2.10', '0.2.11'],
  ['local source to published release', '', '0.2.11'],
  ['published release to local source', '0.2.10', ''],
]) {
  test(`relay upgrade image selection refreshes a retained image when ${label}`, (t) => {
    const harness = createRelayUpgradeImageHarness(t);
    for (const version of [previous, current]) {
      const result = harness.select(version);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `selected=${harness.image}\n`);
      assert.deepEqual(harness.imageArgs(), harness.expectedArgs(version),
        'the selected image must contain the currently requested build inputs at the same checkout HEAD');
      assert.deepEqual(harness.attemptedArgs(), harness.expectedArgs(version),
        'current target and arguments must reach Docker even when the image tag already exists');
    }
  });
}

for (const retainedImage of [false, true]) {
  test(`relay upgrade image selection stops on build failure (${retainedImage ? 'retained image' : 'no image'})`, (t) => {
    const harness = createRelayUpgradeImageHarness(t);
    if (retainedImage) {
      const seed = harness.select('0.2.10');
      assert.equal(seed.status, 0, seed.stderr);
      assert.deepEqual(harness.imageArgs(), harness.expectedArgs('0.2.10'));
    }
    const result = harness.select('0.2.11', true);
    assert.equal(result.status, 42, result.stderr);
    assert.match(result.stderr, /fake docker: build failed/);
    assert.equal(result.stdout, '', 'failed build must not reach the downstream image-selection continuation');
    assert.deepEqual(harness.attemptedArgs(), harness.expectedArgs('0.2.11'));
    if (retainedImage) {
      assert.deepEqual(harness.imageArgs(), harness.expectedArgs('0.2.10'), 'failed build leaves the prior image untouched');
    }
  });
}

test('npm-e2e-smoke includes dockerhub compose and references published images', () => {
  const composePath = join(here, 'compose.dockerhub.yml');
  assert.ok(fs.existsSync(composePath));

  const compose = fs.readFileSync(composePath, 'utf8');
  assert.match(compose, /\n  relay:\n/);
  assert.match(compose, /HAPPIER_RELAY_IMAGE/);
  assert.match(compose, /HAPPIER_DEVBOX_IMAGE/);

  // Ensure the runner defaults target the published dockerhub repositories.
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /happierdev\/relay-server/);
  assert.match(content, /happierdev\/dev-box/);
});

test('npm-e2e-smoke cli-smoke.sh supports preinstalled happier-cli mode', () => {
  const cliSmoke = fs.readFileSync(join(here, 'bin', 'cli-smoke.sh'), 'utf8');
  assert.match(cliSmoke, /HAPPIER_CLI_INSTALL_MODE/);
  assert.match(cliSmoke, /preinstalled/);
  assert.match(cliSmoke, /command -v happier/);
});

test('release-assets-e2e remote host install shims make repeated CLI installs idempotent', () => {
  const entrypoints = [
    join(here, 'bin', 'remote-host-entrypoint.sh'),
    join(here, 'bin', 'remote-host-systemd-entrypoint.sh'),
  ];

  for (const entrypoint of entrypoints) {
    const script = fs.readFileSync(entrypoint, 'utf8');
    assert.match(script, /rm -f "\$prefix\/bin\/happier"/);
    assert.match(script, /npm install -g --force \/packs\/cli\.tgz --no-audit --no-fund/);
  }
});

test('systemd test hosts use Docker-private cgroup mounts, not the read-only host root', () => {
  const dockerfile = fs.readFileSync(join(here, 'Dockerfile.remote-host-systemd'), 'utf8');
  assert.doesNotMatch(dockerfile, /^VOLUME\s+\["\/sys\/fs\/cgroup"\]/m);
  for (const filename of ['compose.remote.yml', 'compose.desktop-setup.yml']) {
    const compose = fs.readFileSync(join(here, filename), 'utf8');
    assert.doesNotMatch(compose, /- \/sys\/fs\/cgroup:\/sys\/fs\/cgroup/);
    assert.match(compose, /privileged: true/);
  }
});

test('npm-e2e-smoke dockerhub postgres smoke waits for postgres readiness', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /waiting for dockerhub postgres/i);
  assert.match(content, /pg_isready/);
});

test('npm-e2e-smoke dockerhub images smoke preflights image availability', () => {
  const content = fs.readFileSync(runScript, 'utf8');
  assert.match(content, /docker manifest inspect/);
});

test('release-assets-e2e run.sh documents relay-server upgrade smoke flags', () => {
  const res = spawnSync('bash', [runScript, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout ?? '', /--with-relay-upgrade/);
  assert.match(res.stdout ?? '', /--no-relay-upgrade/);
  assert.match(res.stdout ?? '', /--relay-upgrade-from-channel=/);
  assert.match(res.stdout ?? '', /--relay-upgrade-db=/);
});

test('release-assets-e2e bootstraps relay auth in a Node-capable smoke container', () => {
  const composePath = join(here, 'compose.dockerhub.yml');
  const compose = YAML.parse(fs.readFileSync(composePath, 'utf8'));
  assert.match(compose.services['auth-bootstrap']?.image ?? '', /^node:22-/);
  assert.ok(compose.services['auth-bootstrap']?.volumes?.some((volume) => String(volume).includes(':/opt/happier-npm-e2e/bin:ro')));
  assert.equal(compose.services.relay?.volumes?.some((volume) => String(volume).includes(':/opt/happier-npm-e2e/bin:ro')), false);

  const script = fs.readFileSync(runScript, 'utf8');
  const upgradeBlock = script.slice(script.indexOf('run_relay_upgrade_smoke()'), script.indexOf('if [[ "$monorepo_mode" == "local" ]]'));
  assert.match(upgradeBlock, /run --rm -T --no-deps[^\n]*auth-bootstrap sh -lc/);
  assert.doesNotMatch(upgradeBlock, /exec -T relay node/);
});

test('release-assets-e2e run.sh cleanup does not crash when docker is unavailable', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'happier-release-assets-e2e-docker-down-test-'));
  const binDir = join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const dockerShim = join(binDir, 'docker');
  fs.writeFileSync(
    dockerShim,
    '#!/usr/bin/env sh\n' +
      'echo "docker shim: unavailable" >&2\n' +
      'exit 1\n',
    { encoding: 'utf8' }
  );
  fs.chmodSync(dockerShim, 0o755);

  const res = spawnSync('bash', [runScript, '--mode=npm', '--no-remote-daemon', '--no-remote-server', '--timeout-s=1'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
  });

  assert.notEqual(res.status, 0);
  assert.doesNotMatch(res.stderr ?? '', /unbound variable/i);
});

test('release-assets-e2e run.sh surfaces npm pack output on failure', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'happier-release-assets-e2e-npm-pack-fail-test-'));
  const binDir = join(tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const dockerShim = join(binDir, 'docker');
  fs.writeFileSync(dockerShim, '#!/usr/bin/env sh\nexit 0\n', { encoding: 'utf8' });
  fs.chmodSync(dockerShim, 0o755);

  const npmShim = join(binDir, 'npm');
  fs.writeFileSync(npmShim, '#!/usr/bin/env sh\necho \"npm shim: pack failed\"\nexit 2\n', { encoding: 'utf8' });
  fs.chmodSync(npmShim, 0o755);

  const res = spawnSync(
    'bash',
    [runScript, '--mode=local', '--no-remote-daemon', '--no-remote-server', '--timeout-s=1', '--keep'],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    }
  );

  assert.equal(res.status, 2, res.stderr || res.stdout);
  assert.match(`${res.stdout ?? ''}\n${res.stderr ?? ''}`, /npm shim: pack failed/);
});
