// @ts-check

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// This driver runs ONLY the self-contained header-action handoff spec, which starts its own
// server, UI, daemons and session. It cannot honor a caller-requested matrix (UI URL, session,
// ordered machine steps), so it refuses those inputs instead of reporting an unrelated pass.
// A successful run records exactly what ran; it never writes matrix meta.json/session results.
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoDir = resolve(join(__dirname, '..', '..'));

const STANDALONE_SPEC = 'packages/tests/suites/ui-e2e/session.handoff.fromHeaderAction.feat.sessions.handoff.spec.ts';
const REQUESTED_MATRIX_INPUTS = ['HAPPIER_QA_STEPS_JSON', 'HAPPIER_QA_SESSION_ID', 'HAPPIER_QA_CREATE_SESSION', 'HAPPIER_UI_URL'];

function requireOutdir() {
  const outdir = String(process.env.HAPPIER_QA_OUTDIR ?? '').trim();
  if (!outdir) {
    // eslint-disable-next-line no-console
    console.error('missing HAPPIER_QA_OUTDIR');
    process.exit(2);
  }
  return outdir;
}

async function writeJson(path, payload) {
  await writeFile(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function runPlaywright({ outdir }) {
  const script = join(repoDir, 'packages', 'tests', 'scripts', 'run-playwright-with-heartbeat.mjs');
  const config = join(repoDir, 'packages', 'tests', 'playwright.ui.config.mjs');
  const spec = join(repoDir, STANDALONE_SPEC);

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script, '--config', config, spec], {
      cwd: repoDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (d) => {
      output += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      output += d.toString();
      process.stderr.write(d);
    });

    child.on('exit', (code, signal) => {
      resolvePromise({ code, signal, output });
    });
  });
}

const outdir = requireOutdir();
await mkdir(outdir, { recursive: true });

const summaryPath = join(outdir, 'summary.json');
const fatalPath = join(outdir, 'fatal.json');

const requestedInputs = REQUESTED_MATRIX_INPUTS.filter((name) => String(process.env[name] ?? '').trim());
if (requestedInputs.length > 0) {
  const refusal = {
    ok: false,
    reason: 'requested_matrix_unsupported',
    error: `This driver only runs the self-contained fixture ${STANDALONE_SPEC} and cannot run the requested matrix (${requestedInputs.join(', ')}).`,
    requestedInputs,
    spec: STANDALONE_SPEC,
  };
  await writeJson(fatalPath, refusal);
  await writeJson(summaryPath, refusal);
  // eslint-disable-next-line no-console
  console.error(`[wsrepl-matrix-driver] ${refusal.error}`);
  process.exit(2);
}

const result = await runPlaywright({ outdir });
const ok = result.code === 0;

if (ok) {
  await writeJson(summaryPath, {
    kind: 'wsrepl_handoff_standalone_fixture_summary',
    ok: true,
    requestedMatrix: false,
    spec: STANDALONE_SPEC,
    subject: 'self_contained_fixture',
  });
  process.exit(0);
}

await writeJson(fatalPath, {
  ok: false,
  reason: 'playwright_failed',
  code: result.code,
  signal: result.signal,
});

process.exit(typeof result.code === 'number' ? result.code : 1);

