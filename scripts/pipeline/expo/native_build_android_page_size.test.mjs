import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createAndroidAabFixture } from './fixtures/android-elf.mjs';

for (const alignment of ['4k', '16k']) {
test(`a completed local Android build ${alignment === '4k' ? 'rejects an incompatible artifact' : 'accepts a compatible artifact'} before writing build metadata`, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-build-page-size-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const artifact = createAndroidAabFixture(directory, { alignment });
  // Keep the artifact above the existing local-build size admission boundary.
  fs.writeFileSync(path.join(directory, 'padding'), Buffer.alloc(1_000_000));
  execFileSync('zip', ['-0q', artifact, 'padding'], { cwd: directory });
  const output = path.join(directory, 'build.json');
  const script = path.resolve(import.meta.dirname, 'native-build.mjs');
  const boundary = `data:text/javascript,${encodeURIComponent(`
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    export function execFileSync() { throw new Error('Unexpected synchronous build command'); }
    export function spawn(command, args) {
      if (command !== 'npx' || (!args.includes('--local') && !args.includes('fingerprint:generate'))) throw new Error('Unexpected build command');
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      queueMicrotask(() => {
        if (args.includes('fingerprint:generate')) child.stdout.write(JSON.stringify({ hash: 'fixture', sources: [] }));
        child.stdout.end(); child.stderr.end(); child.emit('close', 0, null);
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
    '--profile=production', '--build-mode=local', '--local-runtime=host', '--artifact-out', artifact, '--out', output,
  ], { cwd: path.resolve(import.meta.dirname, '../../..'), encoding: 'utf8',
    env: { ...process.env, CI: '1', HAPPIER_PIPELINE_STAGE_EAS_LOCAL_BUILD: 'false' },
  });
  if (alignment === '4k') {
    assert.notEqual(result.status, 0, 'the completed 4KB artifact must fail verification');
    assert.match(result.stderr, /LOAD alignment 4096/);
    assert.equal(fs.existsSync(output), false);
  } else {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).artifactPath, artifact);
  }
});
}
