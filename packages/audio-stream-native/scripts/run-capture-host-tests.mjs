import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inputs = JSON.parse(readFileSync(process.env.HAPPIER_AUDIO_CAPTURE_HOST_INPUTS, 'utf8'));
assert.equal(inputs.platform, 'android-host'); // Swift execution requires its own selected tool/run binding.
assert.equal(inputs.system, 'x86_64-linux');
assert.equal(process.env.HAPPIER_ROUTED_EXECUTOR, 'off');
assert.equal(process.env.JAVA_HOME, inputs.jdkHome);
assert.equal(realpathSync(process.cwd()), realpathSync(path.resolve(packageRoot, '../..')));
function checked(binding) {
  assert.ok(path.isAbsolute(binding.path));
  assert.equal(createHash('sha256').update(readFileSync(binding.path)).digest('hex'), binding.sha256, binding.path);
  return binding.path;
}
for (const binding of inputs.bindings) checked(binding);
const tools = Object.fromEntries(Object.entries(inputs.tools).map(([name, binding]) => [name, checked(binding)]));
assert.equal(realpathSync(process.execPath), realpathSync(tools.node));
assert.ok(Object.values(tools).every((p) => p.startsWith('/nix/store/')));
mkdirSync(inputs.outRoot);
writeFileSync(path.join(inputs.outRoot, 'inputs.json'), JSON.stringify(inputs, null, 2));
const fixtures = path.join(packageRoot, 'scripts/fixtures/j077');
function run(dir, name, executable, args) {
  for (const binding of inputs.bindings) checked(binding);
  const argv = [executable, ...args], start = new Date().toISOString();
  writeFileSync(path.join(dir, `${name}.INTENT.json`), JSON.stringify({ argv, cwd: process.cwd(), start }));
  const result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(path.join(dir, `${name}.stdout`), result.stdout ?? '');
  writeFileSync(path.join(dir, `${name}.stderr`), result.stderr ?? '');
  writeFileSync(path.join(dir, `${name}.RESULT.json`), JSON.stringify({ argv, cwd: process.cwd(), start,
    end: new Date().toISOString(), pid: result.pid, exit: result.status, signal: result.signal, error: result.error?.message ?? null }));
  assert.ifError(result.error); return result;
}
const schedules = ['A01', 'A02', 'A03', 'A04-read', 'A04-event', 'A05', 'A06',
  'A07-constructor', 'A07-state', 'A07-start', 'A07-stop', 'A07-release'];
for (const variant of inputs.variants) test(`actual Android audio capture owner: ${variant.name}`, async (t) => {
  const dir = path.join(inputs.outRoot, variant.name), classes = path.join(dir, 'classes');
  mkdirSync(dir); mkdirSync(classes);
  const module = checked(variant.module), metadata = JSON.stringify(variant);
  const java = run(dir, 'javac', tools.javac, ['-d', classes,
    ...['media/AudioFormat.java', 'media/MediaRecorder.java', 'media/AudioRecord.java', 'util/Base64.java', 'util/Log.java']
      .map((p) => path.join(fixtures, 'android', p))]);
  assert.equal(java.status, 0, java.stderr);
  const jar = path.join(dir, 'capture-fixture.jar');
  const kotlin = run(dir, 'kotlinc', tools.kotlinc, ['-jvm-target', '17', '-classpath', classes,
    '-include-runtime', '-d', jar, module, path.join(fixtures, 'ModuleBoundary.kt'), path.join(fixtures, 'CaptureLifecycleHostTest.kt')]);
  assert.equal(kotlin.status, 0, kotlin.stderr);
  for (const schedule of schedules) {
    const result = run(dir, schedule, tools.java, ['-cp', `${jar}:${classes}`,
      'dev.happier.audio.fixture.CaptureLifecycleHostTestKt', schedule, metadata]);
    assert.ok(result.stdout.includes(`SETUP_READY schedule=${schedule}`), `SETUP FAILURE: ${result.stderr}`);
    await t.test(schedule, () => {
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.ok(result.stdout.includes(`SCHEDULE_PASS ${schedule}`));
    });
  }
});
