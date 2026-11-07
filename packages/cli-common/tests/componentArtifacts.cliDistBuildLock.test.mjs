import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { withBuildSharedDepsLock } from '../../../apps/cli/scripts/buildSharedDeps.mjs';
import { withWorkspaceBundleLock } from '../workspaceBundleLock.mjs';

async function admitExistingWorkspaceBundles(_repoRoot, packageNames) {
  return { ok: true, built: [], skipped: packageNames };
}

function writeWorkspacePackageFixture({ repoRoot, packageName, relativeDir }) {
  const packageDir = join(repoRoot, ...relativeDir);
  const distDir = join(packageDir, 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        version: '0.0.0',
        type: 'module',
        exports: {
          '.': {
            import: {
              default: './dist/index.mjs',
            },
          },
        },
        dependencies: {},
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(join(distDir, 'index.mjs'), `export const packageName = ${JSON.stringify(packageName)};\n`, 'utf8');
}

function writeCliToolUnpackFixture(repoRoot) {
  const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
  const cliToolsArchivesDir = join(repoRoot, 'apps', 'cli', 'tools', 'archives');
  mkdirSync(cliScriptsDir, { recursive: true });
  mkdirSync(cliToolsArchivesDir, { recursive: true });
  writeFileSync(join(cliToolsArchivesDir, 'checksums.sha256'), '', 'utf8');
  writeFileSync(join(cliToolsArchivesDir, 'zellij-no-web-x86_64-unknown-linux-musl.tar.gz'), 'fake zellij archive\n', 'utf8');
  writeFileSync(join(cliToolsArchivesDir, 'zellij-LICENSE'), 'fake zellij license\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'unpack-tools.cjs'), `
const fs = require('fs');
const path = require('path');

async function unpackTools(options = {}) {
  const platformDir = options.platformDir || 'unknown';
  const toolsDir = options.toolsDir || path.resolve(__dirname, '..', 'tools');
  const unpackedPath = path.join(toolsDir, 'unpacked');
  fs.mkdirSync(unpackedPath, { recursive: true });
  const binaryName = platformDir === 'x64-win32' ? 'zellij.exe' : 'zellij';
  fs.writeFileSync(path.join(unpackedPath, binaryName), 'zellij 0.44.3 for ' + platformDir + '\\n');
  fs.writeFileSync(path.join(unpackedPath, '.happier-tools-manifest.json'), JSON.stringify({
    platformDir,
    tools: { zellij: { version: '0.44.3' } },
  }, null, 2) + '\\n');
  return { success: true, alreadyUnpacked: false };
}

module.exports = { unpackTools };
`, 'utf8');
}

function writeCliArtifactFixtures(repoRoot) {
  const cliDir = join(repoRoot, 'apps', 'cli');
  const cliScriptsDir = join(repoRoot, 'apps', 'cli', 'scripts');
  const cliShimsDir = join(cliScriptsDir, 'shims');
  const cliRuntimeDir = join(cliScriptsDir, 'runtime');
  const transformersDir = join(repoRoot, 'node_modules', '@huggingface', 'transformers');
  const ortDir = join(repoRoot, 'node_modules', 'onnxruntime-node');
  const ortCommonDir = join(repoRoot, 'node_modules', 'onnxruntime-common');
  const nodePtyDir = join(repoRoot, 'node_modules', 'node-pty');
  const homebridgePtyDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch');

  mkdirSync(cliDir, { recursive: true });
  mkdirSync(cliShimsDir, { recursive: true });
  mkdirSync(cliRuntimeDir, { recursive: true });
  mkdirSync(transformersDir, { recursive: true });
  mkdirSync(ortDir, { recursive: true });
  mkdirSync(ortCommonDir, { recursive: true });
  mkdirSync(nodePtyDir, { recursive: true });
  mkdirSync(homebridgePtyDir, { recursive: true });

  writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'repo', private: true }, null, 2));
  writeFileSync(
    join(cliDir, 'package.json'),
    JSON.stringify(
      {
        name: '@happier-dev/cli',
        version: '0.0.0',
        dependencies: {
          '@huggingface/transformers': '1.0.0',
          'node-pty': '1.0.0',
          '@homebridge/node-pty-prebuilt-multiarch': '1.0.0',
        },
        bundledDependencies: [
          '@happier-dev/agents',
          '@happier-dev/cli-common',
          '@happier-dev/connection-supervisor',
          '@happier-dev/protocol',
          '@happier-dev/release-runtime',
        ],
      },
      null,
      2,
    ),
    'utf8',
  );
  writeCliToolUnpackFixture(repoRoot);
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/agents', relativeDir: ['packages', 'agents'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/cli-common', relativeDir: ['packages', 'cli-common'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/connection-supervisor', relativeDir: ['packages', 'connection-supervisor'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/protocol', relativeDir: ['packages', 'protocol'] });
  writeWorkspacePackageFixture({ repoRoot, packageName: '@happier-dev/release-runtime', relativeDir: ['packages', 'release-runtime'] });
  writeFileSync(join(cliScriptsDir, 'childProcessOptions.cjs'), 'module.exports = { withWindowsHide: (input) => input };\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'claude_launcher_runtime.cjs'), 'module.exports = { getClaudeCliPath: () => "claude", runClaudeCli: () => {} };\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'claude_local_launcher.cjs'), 'require("./claude_launcher_runtime.cjs");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'claude_remote_launcher.cjs'), 'require("./claude_launcher_runtime.cjs");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'session_hook_forwarder.cjs'), 'console.log("session");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'permission_hook_forwarder.cjs'), 'console.log("permission");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'ripgrep_launcher.cjs'), 'require("./childProcessOptions.cjs");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'statusline_forwarder.cjs'), 'console.log("statusline");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'terminal_launch_spec_runner.cjs'), 'console.log("terminal launch spec");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'process_tree.cjs'), 'console.log("process tree");\n', 'utf8');
  writeFileSync(join(cliScriptsDir, 'node_pty_relay.cjs'), 'console.log("node pty relay");\n', 'utf8');
  writeFileSync(join(cliRuntimeDir, 'loadTransformersFromRuntime.mjs'), 'export const env = {}; export async function pipeline() { return () => null; }\n', 'utf8');
  writeFileSync(join(cliShimsDir, 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
  writeFileSync(join(cliShimsDir, 'rg'), '#!/bin/sh\nexit 0\n', 'utf8');
  writeFileSync(
    join(transformersDir, 'package.json'),
    JSON.stringify({ name: '@huggingface/transformers', version: '1.0.0', dependencies: { 'onnxruntime-node': '1.0.0' } }, null, 2),
  );
  writeFileSync(join(transformersDir, 'index.js'), 'module.exports = {};\n', 'utf8');
  writeFileSync(
    join(ortDir, 'package.json'),
    JSON.stringify({ name: 'onnxruntime-node', version: '1.0.0', dependencies: { 'onnxruntime-common': '1.0.0' } }, null, 2),
  );
  writeFileSync(join(ortDir, 'index.js'), 'module.exports = {};\n', 'utf8');
  writeFileSync(
    join(ortCommonDir, 'package.json'),
    JSON.stringify({ name: 'onnxruntime-common', version: '1.0.0', dependencies: {} }, null, 2),
  );
  writeFileSync(join(ortCommonDir, 'index.js'), 'module.exports = {};\n', 'utf8');
  writeFileSync(
    join(nodePtyDir, 'package.json'),
    JSON.stringify({ name: 'node-pty', version: '1.0.0', dependencies: {} }, null, 2),
  );
  writeFileSync(join(nodePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');
  writeFileSync(
    join(homebridgePtyDir, 'package.json'),
    JSON.stringify({ name: '@homebridge/node-pty-prebuilt-multiarch', version: '1.0.0', dependencies: {} }, null, 2),
  );
  writeFileSync(join(homebridgePtyDir, 'index.js'), 'module.exports = { spawn() {} };\n', 'utf8');
}

test('buildCliBinaryArtifactPayload reuses the first completed dist build across concurrent artifact requests', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-lock-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const payloadDirA = join(tempRoot, 'payload-a');
    const payloadDirB = join(tempRoot, 'payload-b');

    writeCliArtifactFixtures(repoRoot);

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const target = artifacts.resolveCurrentBinaryTarget({
      availableTargets: artifacts.CLI_BINARY_TARGETS,
      platform: 'linux',
      arch: 'x64',
    });

    let releaseFirstBuild = null;
    const firstBuildRelease = new Promise((resolve) => {
      releaseFirstBuild = resolve;
    });
    const runCalls = [];

    const runCommand = async (cmd, args) => {
      runCalls.push({ cmd, args });
      assert.equal(runCalls.length, 1, 'concurrent artifact requests should not trigger a second CLI dist build');
      await firstBuildRelease;
      mkdirSync(cliDistDir, { recursive: true });
      writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli");\n', 'utf8');
    };

    const compileBinary = async ({ outfile }) => {
      writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
    };

    const first = artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir: payloadDirA,
      target,
      commandProbe: () => true,
      runCommand,
      compileBinary,
      ensureWorkspacePackagesBuiltByName: admitExistingWorkspaceBundles,
    });
    const second = artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir: payloadDirB,
      target,
      commandProbe: () => true,
      runCommand,
      compileBinary,
      ensureWorkspacePackagesBuiltByName: admitExistingWorkspaceBundles,
    });

    for (let attempts = 0; attempts < 20 && runCalls.length === 0; attempts += 1) {
      await delay(10);
    }
    assert.equal(runCalls.length, 1, 'the first artifact request should begin the shared CLI dist build');
    releaseFirstBuild();

    await Promise.all([first, second]);

    assert.equal(runCalls.length, 1);
    assert.equal(existsSync(join(payloadDirA, 'happier')), true);
    assert.equal(existsSync(join(payloadDirB, 'happier')), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildCliBinaryArtifactPayload propagates its current owner lease to the real buildSharedDeps lock owner', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-lock-handoff-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const payloadDir = join(tempRoot, 'payload');
    const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');

    writeCliArtifactFixtures(repoRoot);

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const target = artifacts.resolveCurrentBinaryTarget({
      availableTargets: artifacts.CLI_BINARY_TARGETS,
      platform: 'linux',
      arch: 'x64',
    });

    const runCommand = async (_cmd, _args, options) => {
      await withBuildSharedDepsLock(async () => {
        mkdirSync(cliDistDir, { recursive: true });
        writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli");\n', 'utf8');
      }, {
        lockPath,
        env: options?.env,
        timeoutMs: 50,
        pollIntervalMs: 5,
        staleAfterMs: 1_000,
      });
    };

    await artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      target,
      commandProbe: () => true,
      runCommand,
      ensureWorkspacePackagesBuiltByName: admitExistingWorkspaceBundles,
      compileBinary: async ({ outfile }) => {
        writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
      },
    });

    assert.equal(existsSync(join(payloadDir, 'happier')), true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('buildCliBinaryArtifactPayload keeps workspace payload copies in the snapshotted CLI generation', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'component-artifacts-cli-generation-'));
  try {
    const repoRoot = join(tempRoot, 'repo');
    const cliDistDir = join(repoRoot, 'apps', 'cli', 'dist');
    const workspaceDistPath = join(repoRoot, 'packages', 'cli-common', 'dist', 'index.mjs');
    const payloadDir = join(tempRoot, 'payload-a');
    const lockPath = join(repoRoot, '.project', 'tmp', 'cli-dist-build.lock');
    const generationA = 'export const generation = "a";\n';
    const generationB = 'export const generation = "b";\n';

    writeCliArtifactFixtures(repoRoot);
    writeFileSync(workspaceDistPath, generationA, 'utf8');

    const artifacts = await import('../dist/componentArtifacts/index.js');
    const target = artifacts.resolveCurrentBinaryTarget({
      availableTargets: artifacts.CLI_BINARY_TARGETS,
      platform: 'linux',
      arch: 'x64',
    });

    let compileStarted = null;
    const compileStart = new Promise((resolve) => {
      compileStarted = resolve;
    });
    let releaseCompile = null;
    const compileRelease = new Promise((resolve) => {
      releaseCompile = resolve;
    });

    const artifactA = artifacts.buildCliBinaryArtifactPayload({
      repoRoot,
      payloadDir,
      target,
      commandProbe: () => true,
      runCommand: async () => {
        mkdirSync(cliDistDir, { recursive: true });
        writeFileSync(join(cliDistDir, 'index.mjs'), 'console.log("cli generation a");\n', 'utf8');
      },
      ensureWorkspacePackagesBuiltByName: admitExistingWorkspaceBundles,
      compileBinary: async ({ outfile }) => {
        compileStarted();
        await compileRelease;
        writeFileSync(outfile, '#!/bin/sh\necho happier\n', 'utf8');
      },
    });

    await compileStart;
    let observeLockOutcome = null;
    const lockOutcome = new Promise((resolve) => {
      observeLockOutcome = resolve;
    });
    const generationBMutation = withWorkspaceBundleLock(
      async () => {
        writeFileSync(workspaceDistPath, generationB, 'utf8');
        observeLockOutcome('entered');
      },
      {
        lockPath,
        timeoutMs: 2_000,
        pollIntervalMs: 10,
        staleAfterMs: 1_000,
        onWait: () => observeLockOutcome('waited'),
      },
    );

    const outcomeBeforeCompileRelease = await lockOutcome;
    releaseCompile();
    await Promise.all([artifactA, generationBMutation]);

    assert.equal(outcomeBeforeCompileRelease, 'waited');
    assert.equal(
      readFileSync(join(payloadDir, 'node_modules', '@happier-dev', 'cli-common', 'dist', 'index.mjs'), 'utf8'),
      generationA,
    );
    assert.equal(readFileSync(workspaceDistPath, 'utf8'), generationB);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
