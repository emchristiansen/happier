import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectReleaseStatus } from '../pipeline/release/project-release-status.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const rollingTags = ['server-dev', 'stack-dev', 'cli-dev', 'ui-web-dev', 'ui-mobile-dev', 'ui-desktop-dev'];
const admissionCases = [
  { name: 'complete publication', decision: 'already_current' },
  { name: 'annotated current tag', annotated: true, decision: 'already_current' },
  ...rollingTags.flatMap((tag) => [
    { name: `missing ${tag}`, tag, missingTag: true, decision: 'publish' },
    { name: `forward-stale ${tag}`, tag, staleTag: true, decision: 'publish' },
    { name: `missing Release ${tag}`, tag, missingRelease: true, decision: 'publish' },
    { name: `stale Release ${tag}`, tag, staleRelease: true, decision: 'publish' },
  ]),
  { name: 'tag read unavailable', tag: 'ui-mobile-dev', missingTag: true, readFailure: true, decision: 'publish' },
  { name: 'Release read unavailable', tag: 'ui-desktop-dev', missingRelease: true, readFailure: true, decision: 'publish' },
  { name: 'malformed tag object', tag: 'ui-mobile-dev', malformedTag: true, decision: 'publish' },
  { name: 'empty Release target', tag: 'ui-desktop-dev', emptyRelease: true, decision: 'publish' },
  { name: 'divergent core tag', tag: 'server-dev', staleTag: true, compare: 'diverged', refused: true },
  { name: 'divergent mobile tag', tag: 'ui-mobile-dev', staleTag: true, compare: 'diverged', refused: true },
  { name: 'ancestry query failure', tag: 'server-dev', staleTag: true, compareFailure: true, refused: true },
  { name: 'CI unavailable', ci: 'false', decision: 'blocked_ci' },
  { name: 'newer uncertified HEAD', newerHead: true, decision: 'blocked_ci' },
  { name: 'manual dispatch', event: 'workflow_dispatch', decision: 'publish' },
];

for (const fixture of admissionCases) {
  test(`nightly actual admission: ${fixture.name}`, async (t) => {
    const workflow = YAML.parse(await readFile(join(repoRoot, '.github/workflows/nightly-dev.yml'), 'utf8'));
    const steps = workflow.jobs.prepare_release_candidate.steps.filter((step) => step.id === 'release_need');
    assert.equal(steps.length, 1);
    assert.equal(typeof steps[0].run, 'string');
    const root = await mkdtemp(join(tmpdir(), 'nightly-publication-admission-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const privatePath = join(root, 'private-bin');
    await mkdir(privatePath);
    const sourceSha = 'a'.repeat(40);
    const staleSha = 'b'.repeat(40);
    const annotationSha = 'c'.repeat(40);
    const responses = new Map();
    for (const tag of rollingTags) {
      const selected = fixture.tag === tag;
      const tagValue = selected && fixture.staleTag ? staleSha : sourceSha;
      const object = selected && fixture.malformedTag ? `blob ${sourceSha}`
        : fixture.annotated && tag === 'cli-dev' ? `tag ${annotationSha}` : `commit ${tagValue}`;
      responses.set(`api repos/fixture/repo/git/ref/tags/${tag} --jq .object.type + " " + .object.sha`, {
        value: selected && fixture.missingTag && !fixture.readFailure ? '' : object,
        exit: selected && fixture.missingTag ? 1 : 0,
      });
      responses.set(`api repos/fixture/repo/releases/tags/${tag} --jq .target_commitish`, {
        value: selected && (fixture.emptyRelease || (fixture.missingRelease && !fixture.readFailure)) ? ''
          : selected && fixture.staleRelease ? staleSha : sourceSha,
        exit: selected && fixture.missingRelease ? 1 : 0,
      });
    }
    responses.set(`api repos/fixture/repo/git/tags/${annotationSha} --jq .object.type + " " + .object.sha`, {
      value: `commit ${sourceSha}`, exit: 0,
    });
    responses.set(`api repos/fixture/repo/compare/${staleSha}...${sourceSha} --jq .status`, {
      value: fixture.compare || 'ahead', exit: fixture.compareFailure ? 1 : 0,
    });
    const shellLiteral = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
    const arms = [...responses].map(([args, response]) => `${shellLiteral(args)})
      printf '%s\\n' ${shellLiteral(response.value)}
      return ${response.exit} ;;`).join('\n');
    const outputPath = join(root, 'output');
    const logPath = join(root, 'gh-calls');
    const unexpectedPath = join(root, 'unexpected');
    // No executable is reachable on PATH. gh is an asserted local function;
    // every accepted operation and its result are enumerated above.
    const script = `set -euo pipefail
      gh() {
        if [ "$*" = '--fixture-guard' ]; then printf '%s' fixture-only; return 0; fi
        printf '%s\\n' "$*" >> "$FIXTURE_GH_LOG"
        case "$*" in
          ${arms}
          *) printf '%s\\n' "$*" >> "$FIXTURE_UNEXPECTED"; return 99 ;;
        esac
      }
      [ "$(type -t gh)" = function ]
      [ "$(gh --fixture-guard)" = fixture-only ]
      ${steps[0].run}`;
    const result = spawnSync(process.env.HAPPIER_TEST_BASH || '/bin/bash', ['--noprofile', '--norc', '-c', script], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: privatePath,
        EVENT_NAME: fixture.event || 'schedule',
        CI_AVAILABLE: fixture.ci || 'true',
        SOURCE_SHA: sourceSha,
        HEAD_SHA: fixture.newerHead ? 'd'.repeat(40) : sourceSha,
        GITHUB_REPOSITORY: 'fixture/repo',
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: join(root, 'summary'),
        FIXTURE_GH_LOG: logPath,
        FIXTURE_UNEXPECTED: unexpectedPath,
      },
    });
    assert.ifError(result.error);
    const unexpected = await readFile(unexpectedPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    assert.equal(unexpected, '', 'the actual admission crossed an unexpected fake-gh boundary');
    const output = await readFile(outputPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const fields = Object.fromEntries(output.trim().split('\n').filter(Boolean).map((line) => {
      const index = line.indexOf('=');
      assert.ok(index > 0);
      return [line.slice(0, index), line.slice(index + 1)];
    }));
    if (fixture.refused) {
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.notEqual(fields.decision, 'already_current');
      return;
    }
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fields.decision, fixture.decision);
    assert.equal(fields.release_needed, fixture.decision === 'publish' ? 'true' : 'false');
    assert.equal(fields.waiting_for_ci, fixture.decision === 'blocked_ci' ? 'true' : 'false');
    const status = projectReleaseStatus('nightly', {
      RELEASE_RUN: '74', RELEASE_RUN_URL: 'https://github.com/fixture/repo/actions/runs/74', RELEASE_RUN_NAME: 'offline admission',
      SOURCE_SHA: sourceSha, NIGHTLY_DECISION: fields.decision,
    });
    if (fixture.decision === 'already_current') {
      assert.equal(status.terminal, 'complete');
      const calls = await readFile(logPath, 'utf8');
      for (const tag of rollingTags) {
        assert.ok(calls.includes(`git/ref/tags/${tag} --jq `), `${tag} commit evidence was not read`);
        assert.ok(calls.includes(`releases/tags/${tag} --jq .target_commitish`), `${tag} Release evidence was not read`);
      }
    } else {
      assert.notEqual(status.terminal, 'complete');
    }
  });
}

test('nightly-dev uses generic unattended copy instead of requiring a human-approved release-note entry', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'nightly-dev.yml'), 'utf8');
  assert.match(raw, /prepare_release_candidate:[\s\S]*?release_message: \$\{\{ steps\.identity\.outputs\.release_message \}\}/);
  assert.match(raw, /echo "release_message=Automated nightly dev release\."/);
  assert.doesNotMatch(raw, /project-release-notes\.mjs/);
  assert.doesNotMatch(raw, /release_notes_github_markdown|release_notes_expo_message/);
});

test('nightly-dev verifies exact immutable candidates before promoting rolling references', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'nightly-dev.yml'), 'utf8');
  const releaseVerifyBlock = raw.slice(raw.indexOf('\n  release_verify:'), raw.indexOf('\n  promote_server:'));

  assert.match(raw, /prepare_release_candidate:[\s\S]*?source_sha:/);

  for (const job of ['cli', 'hstack', 'server_runtime', 'ui_web']) {
    assert.match(
      raw,
      new RegExp(`${job}:[\\s\\S]*?needs:\\s*\\[resolve_resume, prepare_release_candidate, verify_source_ci\\][\\s\\S]*?publish_rolling:\\s*false`),
      `${job} should publish an immutable candidate without moving its rolling reference`,
    );
  }

  assert.match(
    raw,
    /release_verify:[\s\S]*?needs:\s*\[prepare_release_candidate, cli, hstack, server_runtime, ui_web, resolve_validation_risk\][\s\S]*?candidate_source_sha:\s*\$\{\{ needs\.prepare_release_candidate\.outputs\.source_sha \}\}[\s\S]*?candidate_cli_version:\s*\$\{\{ needs\.cli\.outputs\.version \}\}[\s\S]*?candidate_stack_version:\s*\$\{\{ needs\.hstack\.outputs\.version \}\}[\s\S]*?candidate_server_version:\s*\$\{\{ needs\.server_runtime\.outputs\.version \}\}[\s\S]*?candidate_ui_web_version:\s*\$\{\{ needs\.ui_web\.outputs\.version \}\}/,
    'release verification should consume the exact SHA and immutable versions produced by candidate jobs',
  );

  assert.match(raw, /promote_server:[\s\S]*?needs:\s*\[prepare_release_candidate, server_runtime, release_verify\]/);
  assert.match(raw, /promote_hstack:[\s\S]*?needs:\s*\[prepare_release_candidate, hstack, release_verify\]/);
  assert.match(raw, /promote_cli:[\s\S]*?needs:\s*\[prepare_release_candidate, cli, release_verify\]/);
  assert.match(raw, /promote_ui_web:[\s\S]*?needs:\s*\[prepare_release_candidate, ui_web, release_verify\]/);
  assert.match(
    raw,
    /docker:[\s\S]*?needs:\s*\[prepare_release_candidate, cli, server_runtime, release_verify\][\s\S]*?server_version:\s*\$\{\{ needs\.server_runtime\.outputs\.version \}\}[\s\S]*?cli_version:\s*\$\{\{ needs\.cli\.outputs\.version \}\}/,
    'Docker should wait for grouped verification and consume the exact verified CLI and server candidate versions',
  );
  assert.match(
    raw,
    /verify_promoted:[\s\S]*?needs:\s*\[prepare_release_candidate, promote_server, promote_hstack, promote_cli, promote_ui_web, ui_mobile, ui_desktop\][\s\S]*?for tag in server-dev stack-dev cli-dev ui-web-dev ui-mobile-dev ui-desktop-dev/,
    'terminal promotion verification must wait for and inspect every user-facing rolling GitHub Release',
  );
  assert.match(raw, /resolve_tag_commit\(\)/, 'rolling verification should dereference annotated as well as lightweight tags');
  assert.match(
    raw,
    /releases\/tags\/\$\{tag\}[\s\S]*?--jq '\.target_commitish'[\s\S]*?test "\$release_target" = "\$EXPECTED_SHA"/,
    'rolling verification must reject stale GitHub Release target metadata even when the git tag is current',
  );

  assert.doesNotMatch(
    releaseVerifyBlock,
    /needs:\s*\[[^\]]*(?:ui_mobile|ui_desktop|docker)/,
    'candidate verification must not depend on jobs that already publish user-consumed mobile, desktop, or Docker outputs',
  );
  const promotedVerificationBlock = raw.slice(raw.indexOf('\n  verify_promoted:'), raw.indexOf('\n  advance_source_issues_to_dev:'));
  assert.doesNotMatch(promotedVerificationBlock, /needs:\s*\[[^\]]*docker/, 'Docker publication has no GitHub rolling Release to verify');
});

test('nightly-dev publishes the newest forward-only CI-certified dev SHA and reports blocked newer heads', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'nightly-dev.yml'), 'utf8');

  assert.match(
    raw,
    /verify_source_ci:[\s\S]*?needs:\s*\[prepare_release_candidate\][\s\S]*?timeout-minutes:\s*15[\s\S]*?actions:\s*read[\s\S]*?args=\([\s\S]*?--source-sha "\$SOURCE_SHA"[\s\S]*?--source-branch dev[\s\S]*?verify-existing-ci\.mjs "\$\{args\[@\]\}"/,
    'the exact candidate SHA must have successful canonical push CI before publication starts',
  );
  assert.match(raw, /CI_RUN_ID:\s*\$\{\{ needs\.prepare_release_candidate\.outputs\.ci_run_id \}\}/, 'the bound CI run id must be passed through an environment variable');
  assert.match(raw, /--run-id "\$CI_RUN_ID"/, 'CI run id must be shell-quoted when forwarded to the verifier');
  assert.match(
    raw,
    /EVENT_NAME[\s\S]*?actions\/workflows\/tests\.yml\/runs\?branch=dev&event=push&status=success&per_page=100[\s\S]*?head_branch == "dev"[\s\S]*?source_sha=\$candidate_sha/,
    'scheduled nightlies must bind the newest successful canonical dev CI instead of requiring current HEAD itself to be green',
  );
  assert.doesNotMatch(raw, /actions\/workflows\/tests\.yml\/runs\?[^\n]*head_sha=/);
  assert.doesNotMatch(raw, /format\(\x27--run-id \{0\}\x27/, 'CI run id must not be interpolated into an unquoted shell fragment');
  assert.match(
    raw,
    /prepare_release_candidate:[\s\S]*?decision:\s*\$\{\{ steps\.release_need\.outputs\.decision \}\}[\s\S]*?for tag in server-dev stack-dev cli-dev ui-web-dev[\s\S]*?compare\/\$\{actual\}\.\.\.\$\{SOURCE_SHA\}[\s\S]*?blocked_ci[\s\S]*?already_current/,
    'scheduled publication must reject rollback/divergence and distinguish a blocked newer head from an already-current green head',
  );
  for (const job of ['cli', 'hstack', 'server_runtime', 'ui_web', 'resolve_validation_risk']) {
    assert.match(
      raw,
      new RegExp(`${job}:[\\s\\S]*?if:\\s*\\$\\{\\{ needs\\.prepare_release_candidate\\.outputs\\.release_needed == 'true' \\}\\}`),
      `${job} must not run for a proven unchanged scheduled nightly`,
    );
  }
  assert.match(raw, /nightly_waiting_for_ci:[\s\S]*?exit 1/);
  assert.match(raw, /nightly_noop:[\s\S]*?release_needed == 'false'[\s\S]*?already completed and promoted/);
  assert.match(raw, /release_status:[\s\S]*?if:\s*\$\{\{ always\(\) \}\}[\s\S]*?nightly_waiting_for_ci[\s\S]*?nightly_noop/);
  assert.match(raw, /NIGHTLY_DECISION:\s*\$\{\{ needs\.prepare_release_candidate\.outputs\.decision \|\| 'blocked_ci' \}\}/);
});

test('nightly-dev propagates generic unattended copy and terminal status', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'nightly-dev.yml'), 'utf8');

  for (const job of [
    'cli',
    'hstack',
    'server_runtime',
    'ui_web',
    'promote_server',
    'promote_hstack',
    'promote_cli',
    'promote_ui_web',
  ]) {
    assert.match(
      raw,
      new RegExp(job + ':[\\s\\S]*?needs:\\s*\\[[^\\]]*prepare_release_candidate[^\\]]*\\][\\s\\S]*?release_message:\\s*\\$\\{\\{\\s*needs\\.prepare_release_candidate\\.outputs\\.release_message\\s*\\}\\}'),
      job + ' must consume the generic unattended nightly copy',
    );
  }

  assert.match(
    raw,
    /ui_mobile:[\s\S]*?release_message:\s*\$\{\{\s*needs\.prepare_release_candidate\.outputs\.release_message\s*\}\}/,
    'mobile nightly metadata must use generic unattended copy',
  );
  assert.match(
    raw,
    /ui_desktop:[\s\S]*?release_message:\s*\$\{\{\s*needs\.prepare_release_candidate\.outputs\.release_message\s*\}\}/,
    'desktop nightly publication must receive generic unattended copy',
  );
  assert.match(
    raw,
    /release_status:[\s\S]*?if:\s*\$\{\{\s*always\(\)[^}]*\}\}[\s\S]*?needs:\s*\[[^\]]*hstack[^\]]*promote_hstack[^\]]*\][\s\S]*?project-release-status\.mjs[\s\S]*?GITHUB_STEP_SUMMARY/,
    'nightly terminal status must include the HStack candidate and promotion outcomes',
  );
});

test('ordinary nightlies advance the pre-bound source issue snapshot only after dev promotion is verified', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'nightly-dev.yml'), 'utf8');

  assert.match(raw, /snapshot_source_issues:[\s\S]*?issues:\s*read[\s\S]*?reconcile-issue-stage\.mjs snapshot[\s\S]*?from-stage "stage:source"/);
  assert.match(raw, /prepare_release_candidate:[\s\S]*?needs:\s*\[resolve_resume, snapshot_source_issues\]/);
  assert.match(
    raw,
    /advance_source_issues_to_dev:[\s\S]*?source_sha == needs\.prepare_release_candidate\.outputs\.head_sha[\s\S]*?needs:\s*\[snapshot_source_issues, prepare_release_candidate, verify_promoted\][\s\S]*?issues:\s*write[\s\S]*?reconcile-issue-stage\.mjs advance[\s\S]*?from-stage "stage:source"[\s\S]*?to-stage "stage:dev"/,
  );
  assert.match(raw, /SOURCE_ISSUES_JSON:\s*\$\{\{ needs\.snapshot_source_issues\.outputs\.issues_json \}\}/);
  assert.match(raw, /RESUME_RUN_ID:\s*\$\{\{ inputs\.resume_run_id \}\}[\s\S]*?SOURCE_REF:\s*\$\{\{ inputs\.source_ref \}\}/);
  assert.match(raw, /\[ -n "\$RESUME_RUN_ID" \][\s\S]*?"\$SOURCE_REF" != "dev"/);
  assert.match(raw, /"\$SOURCE_REF" != "dev"[\s\S]*?eligible=false/);
});

test('nightly status projector emits the strict summarizer contract', () => {
  const sourceSha = 'a'.repeat(40);
  const producerEnv = {
      ...process.env,
      GITHUB_RUN_ID: '12345',
      RELEASE_RUN: '12345',
      RELEASE_RUN_URL: 'https://github.com/happier-dev/happier/actions/runs/12345',
      RELEASE_RUN_NAME: 'NIGHTLY — Dev Releases',
      SOURCE_SHA: sourceSha,
      CANDIDATE_RESULT: 'success',
      IMMUTABLE_VERIFICATION_RESULT: 'success',
      CLI_CANDIDATE_RESULT: 'success',
      CLI_CANDIDATE_VERSION: '0.2.10-dev.1',
      STACK_CANDIDATE_RESULT: 'success',
      STACK_CANDIDATE_VERSION: '0.2.10-dev.1',
      SERVER_CANDIDATE_RESULT: 'success',
      SERVER_CANDIDATE_VERSION: '0.2.10-dev.1',
      UI_WEB_CANDIDATE_RESULT: 'success',
      UI_WEB_CANDIDATE_VERSION: '0.2.10-dev.1',
      CLI_RESULT: 'success',
      STACK_RESULT: 'success',
      SERVER_RESULT: 'success',
      UI_WEB_RESULT: 'success',
      MOBILE_RESULT: 'success',
      DESKTOP_RESULT: 'success',
      DOCKER_RESULT: 'success',
      POST_PROMOTION_RESULT: 'success',
      VERIFY_RESULT: 'success',
      PROMOTE_SERVER_RESULT: 'success',
      PROMOTE_HSTACK_RESULT: 'success',
      PROMOTE_CLI_RESULT: 'success',
      PROMOTE_UI_WEB_RESULT: 'success',
      UI_MOBILE_RESULT: 'success',
      UI_DESKTOP_RESULT: 'success',
      VERIFY_PROMOTED_RESULT: 'success',
  };
  const summary = projectReleaseStatus('nightly', producerEnv);

  assert.deepEqual(summary.run, {
    id: 12345,
    url: 'https://github.com/happier-dev/happier/actions/runs/12345',
    name: 'NIGHTLY — Dev Releases',
  });
  assert.equal(summary.terminal, 'published');
  assert.ok(summary.surfaces.every((surface) => surface.evidence === 'verified' || surface.evidence === 'accepted'));

  const unverifiedSummary = projectReleaseStatus('nightly', {
    ...producerEnv,
    IMMUTABLE_VERIFICATION_RESULT: 'failure',
  });
  for (const id of [
    'cli-immutable-candidate',
    'hstack-immutable-candidate',
    'server-immutable-candidate',
    'ui-web-immutable-candidate',
  ]) {
    const surface = unverifiedSummary.surfaces.find((entry) => entry.id === id);
    assert.equal(surface?.state, 'partial', `${id} must not become resumable without grouped candidate verification`);
    assert.equal(surface?.identity?.verified, false);
  }
});
