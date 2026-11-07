import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Kept in test:native so ordinary JS-only validation does not require a C++ toolchain.
test("native streaming ASR finalizes the last words at the stream's input sample rate", {
  skip: process.env.HAPPIER_SHERPA_J075_HOST === "1" && process.env.HAPPIER_SHERPA_J075_FINISH_CONTROL === "0",
}, () => {
  const buildDir = mkdtempSync(path.join(tmpdir(), "sherpa-asr-finish-"));
  try {
    const binary = path.join(buildDir, process.platform === "win32" ? "asr-finish.exe" : "asr-finish");
    const compile = spawnSync(process.env.CXX || "c++", [
      "-std=c++17", "-Wall", "-Wextra", "-Werror",
      "-I", path.join(packageRoot, "common", "cpp"),
      "-I", path.join(packageRoot, "android", "src", "main", "cpp", "include"),
      path.join(packageRoot, "scripts", "online-asr-finish.test.cpp"), "-o", binary,
    ], { encoding: "utf8" });
    assert.ifError(compile.error);
    assert.equal(compile.status, 0, compile.stderr);

    const result = spawnSync(binary, [], { encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
});

// Explicit immutable inputs only: ordinary test:native does not require a JVM or fetch tools.
if (process.env.HAPPIER_SHERPA_J075_HOST === "1") {
  const inputs = JSON.parse(readFileSync(process.env.HAPPIER_SHERPA_J075_HOST_TOOL_INPUTS, "utf8"));
  assert.equal(inputs.system, "x86_64-linux");
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  function checkedFile(binding) {
    assert.ok(path.isAbsolute(binding.path));
    assert.equal(digest(readFileSync(binding.path)), binding.sha256, binding.path);
    return binding.path;
  }
  for (const binding of inputs.bindings) checkedFile(binding);
  const tools = Object.fromEntries(Object.entries(inputs.tools).map(([name, binding]) => [name, checkedFile(binding)]));
  assert.equal(realpathSync(process.execPath), realpathSync(tools.node));
  for (const executable of Object.values(tools)) assert.ok(executable.startsWith("/nix/store/"));
  assert.equal(process.env.JAVA_HOME, inputs.jdkHome);
  assert.equal(process.env.HAPPIER_ROUTED_EXECUTOR, "off");
  assert.equal(realpathSync(process.cwd()), realpathSync(path.resolve(packageRoot, "../..")));
  const fixture = path.join(packageRoot, "scripts", "fixtures", "j075");
  const schedules = ["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10", "S11",
    "S12-create", "S12-enqueue", "S12-terminal", "S12-cancel", "S12-tts", "S12-dispose"];
  const output = inputs.outRoot;
  assert.ok(path.isAbsolute(output));
  mkdirSync(output, { recursive: false });
  writeFileSync(path.join(output, "tool-inputs.json"), JSON.stringify(inputs, null, 2));
  function run(directory, name, executable, args) {
    for (const binding of inputs.bindings) checkedFile(binding);
    const startedAt = new Date().toISOString();
    const argv = [executable, ...args];
    writeFileSync(path.join(directory, `${name}.INTENT.json`), JSON.stringify({ argv, cwd: process.cwd(), startedAt }));
    const result = spawnSync(executable, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const endedAt = new Date().toISOString();
    writeFileSync(path.join(directory, `${name}.stdout`), result.stdout ?? "");
    writeFileSync(path.join(directory, `${name}.stderr`), result.stderr ?? "");
    writeFileSync(path.join(directory, `${name}.RESULT.json`), JSON.stringify({ argv, cwd: process.cwd(),
      pid: result.pid, startedAt, endedAt, exit: result.status, signal: result.signal, error: result.error?.message ?? null }));
    assert.ifError(result.error);
    return result;
  }
  for (const variant of inputs.variants) {
    test(`J075 actual module and full JNI: ${variant.name}`, async (t) => {
      const dir = path.join(output, variant.name);
      mkdirSync(dir); mkdirSync(path.join(dir, "classes")); mkdirSync(path.join(dir, "native"));
      const moduleSource = checkedFile(variant.module);
      const jniSource = checkedFile(variant.jni);
      const metadata = JSON.stringify({ variant: variant.name, commit: variant.commit,
        module: variant.module, jni: variant.jni });
      writeFileSync(path.join(dir, "source.json"), metadata);
      const classes = path.join(dir, "classes"), jar = path.join(dir, "module-fixture.jar");
      const java = run(dir, "javac", tools.javac, ["-d", classes,
        path.join(fixture, "android/util/Base64.java"), path.join(fixture, "android/util/Log.java")]);
      assert.equal(java.status, 0, java.stderr);
      const kotlin = run(dir, "kotlinc", tools.kotlinc, ["-jvm-target", "17", "-classpath", classes,
        "-include-runtime", "-d", jar, moduleSource,
        ...["ModuleBoundary.kt", "PromiseBoundary.kt", "ControlledExecutor.kt", "ModuleLifecycleHostTest.kt", "NativeProbe.kt"]
          .map((name) => path.join(fixture, name))]);
      assert.equal(kotlin.status, 0, kotlin.stderr);
      const cpp = run(dir, "cxx", tools.cxx, ["-std=c++17", "-O0", "-g", "-Wall", "-Wextra", "-Werror",
        "-fPIC", "-shared", "-pthread", "-Wl,-z,defs", "-I", path.join(inputs.jdkHome, "include"),
        "-I", path.join(inputs.jdkHome, "include/linux"), "-I", path.join(fixture, "include"),
        "-I", path.join(packageRoot, "android/src/main/cpp/include"), "-I", path.join(packageRoot, "common/cpp"),
        jniSource, path.join(fixture, "native-boundary.cpp"), "-ldl", "-o", path.join(dir, "native/libhappier_sherpa_jni.so")]);
      assert.equal(cpp.status, 0, cpp.stderr);
      for (const schedule of schedules) {
        const result = run(dir, schedule, tools.java, ["-Xcheck:jni", `-Djava.library.path=${path.join(dir, "native")}`,
          "-cp", `${jar}:${classes}`, "dev.happier.sherpa.fixture.ModuleLifecycleHostTestKt", schedule, metadata]);
        assert.ok(result.stdout.includes(`SETUP_READY schedule=${schedule}`), `SETUP FAILURE: ${result.stderr}`);
        await t.test(schedule, () => {
          assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
          assert.ok(result.stdout.includes(`SCHEDULE_PASS ${schedule}`));
        });
      }
    });
  }
}
