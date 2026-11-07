import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createAndroidAabFixture } from './fixtures/android-elf.mjs';

for (const { alignment, writesArtifact, exitCode, cleanupFailure = true } of [
  { alignment: '4k', writesArtifact: true, exitCode: 0 },
  { alignment: '16k', writesArtifact: true, exitCode: 0 },
  { alignment: '16k', writesArtifact: false, exitCode: 1 },
  { alignment: '16k', writesArtifact: true, exitCode: 1 },
  { alignment: '16k', writesArtifact: false, exitCode: 0 },
  { alignment: '16k', writesArtifact: true, exitCode: 1, cleanupFailure: false },
]) {
test(`local Android build validates the current output before metadata (alignment: ${alignment}, writes: ${writesArtifact}, exit: ${exitCode}, cleanup: ${cleanupFailure})`, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-build-page-size-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const artifact = createAndroidAabFixture(directory, { alignment });
  // Keep the artifact above the existing local-build size admission boundary.
  fs.writeFileSync(path.join(directory, 'padding'), Buffer.alloc(1_000_000));
  execFileSync('zip', ['-0q', artifact, 'padding'], { cwd: directory });
  const requestedArtifact = path.join(directory, 'current.aab');
  fs.copyFileSync(artifact, requestedArtifact);
  const previousBytes = fs.readFileSync(requestedArtifact);
  const output = path.join(directory, 'build.json');
  const script = path.resolve(import.meta.dirname, 'native-build.mjs');
  const boundary = `data:text/javascript,${encodeURIComponent(`
    import { copyFileSync } from 'node:fs';
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    export function execFileSync() { throw new Error('Unexpected synchronous build command'); }
    export function spawn(command, args) {
      if (command !== 'npx' || (!args.includes('--local') && !args.includes('fingerprint:generate'))) throw new Error('Unexpected build command');
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      queueMicrotask(() => {
        if (args.includes('fingerprint:generate')) child.stdout.write(JSON.stringify({ hash: 'fixture', sources: [] }));
        if (args.includes('--local') && ${writesArtifact}) copyFileSync(${JSON.stringify(artifact)}, args[args.indexOf('--output') + 1]);
        if (args.includes('--local') && ${exitCode} !== 0) child.stderr.write(${JSON.stringify(cleanupFailure ? "ENOTEMPTY: directory not empty, rmdir '/fixture/.git'" : "Build failed before completion")});
        child.stdout.end(); child.stderr.end(); child.emit('close', args.includes('--local') ? ${exitCode} : 0, null);
      });
      return child;
    }
  `)}`;
  const loader = path.join(directory, 'loader.mjs');
  fs.writeFileSync(loader, `export function resolve(specifier, context, next) {
    if (specifier === 'node:child_process' && context.parentURL === ${JSON.stringify(pathToFileURL(script).href)})
      return { url: ${JSON.stringify(boundary)}, shortCircuit: true };
    return next(specifier, context);
  }`);
  const preload = path.join(directory, 'register.mjs');
  fs.writeFileSync(preload, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, import.meta.url);`);
  const result = spawnSync(process.execPath, ['--import', preload, script, '--platform=android',
    '--profile=production', '--build-mode=local', '--local-runtime=host', '--artifact-out', requestedArtifact, '--out', output,
  ], { cwd: path.resolve(import.meta.dirname, '../../..'), encoding: 'utf8',
    env: { ...process.env, CI: '1', HAPPIER_PIPELINE_STAGE_EAS_LOCAL_BUILD: 'false' },
  });
  assert.ifError(result.error);
  if (!writesArtifact || (exitCode !== 0 && !cleanupFailure)) {
    assert.notEqual(result.status, 0, 'a build without accepted current output cannot reuse the previous artifact');
    assert.equal(fs.existsSync(output), false, 'no new success metadata for the old artifact');
    assert.deepEqual(fs.readFileSync(requestedArtifact), previousBytes, 'failed attempt preserves previous output');
  } else if (alignment === '4k') {
    assert.notEqual(result.status, 0, 'the completed 4KB artifact must fail verification');
    assert.match(result.stderr, /LOAD alignment 4096/);
    assert.equal(fs.existsSync(output), false);
  } else {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).artifactPath, requestedArtifact);
  }
});
}
