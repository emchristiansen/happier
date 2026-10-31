import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

async function readSource(relativeUrl: string): Promise<string> {
  return await readFile(new URL(relativeUrl, import.meta.url), 'utf8');
}

function expectSourceContains(source: string, pattern: RegExp, label: string): void {
  expect.soft(source, label).toMatch(pattern);
}

const CLI_SRC_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Connected-services PRODUCTION roots swept by the negative boundedness scan. */
const SCAN_ROOTS = [
  'daemon/connectedServices',
  'backends/claude/connectedServices',
  'backends/codex/connectedServices',
  'backends/gemini/connectedServices',
  'backends/opencode/connectedServices',
  'backends/pi/connectedServices',
] as const;

async function listProductionSources(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
      out.push(path);
    }
  }
  await walk(join(CLI_SRC_ROOT, root));
  return out;
}

/**
 * Occurrences that ARE bounded but whose budget lives outside the heuristic window. Every entry
 * needs a one-line justification; additions without one should be treated as review findings.
 */
const BOUNDED_CALL_ALLOWLIST: ReadonlyArray<Readonly<{ file: string; marker: string; reason: string }>> = [];

function windowAround(source: string, index: number, before: number, after: number): string {
  const lines = source.slice(0, index).split('\n');
  const lineIndex = lines.length - 1;
  const all = source.split('\n');
  return all.slice(Math.max(0, lineIndex - before), lineIndex + after).join('\n');
}

/** Blanks comments (preserving offsets/newlines) so the scan only sees executable call sites. */
function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (match) => match.replace(/[^\n]/gu, ' '))
    .replace(/(^|[^:"'`])\/\/[^\n]*/gu, (match, prefix: string) =>
      `${prefix}${' '.repeat(match.length - prefix.length)}`);
}

describe('connected service external wait boundedness invariant guard', () => {
  it('keeps OAuth refresh, macOS security, and provider quota fetch leaves bounded', async () => {
    const [
      serviceRefreshers,
      keychain,
      quotasCoordinator,
      codexQuotaFetcher,
      claudeQuotaFetcher,
    ] = await Promise.all([
      readSource('./serviceRefreshers.ts'),
      readSource('../../../backends/claude/connectedServices/nativeAuth/claudeCodeMacOsKeychain.ts'),
      readSource('../quotas/ConnectedServiceQuotasCoordinator.ts'),
      readSource('../../../backends/codex/connectedServices/quotaFetcher.ts'),
      readSource('../../../backends/claude/connectedServices/quotaFetcher.ts'),
    ]);

    expectSourceContains(
      serviceRefreshers,
      /const CONNECTED_SERVICE_OAUTH_REFRESH_FETCH_TIMEOUT_MS = \d[\d_]*;[\s\S]*AbortSignal\.timeout\(CONNECTED_SERVICE_OAUTH_REFRESH_FETCH_TIMEOUT_MS\)[\s\S]*AbortSignal\.any\(\[containingSignal, timeout\]\)[\s\S]*fetch\(config\.tokenUrl,[\s\S]*signal: buildRefreshAbortSignal\(params\.signal\)/u,
      'OAuth token refresh must preserve containing cancellation and its bounded timeout',
    );

    expectSourceContains(
      keychain,
      /const timeout = setTimeout\([\s\S]*child\.kill\('SIGTERM'\)[\s\S]*reject\(buildKeychainTimeoutError\(\)\)[\s\S]*timeoutMs\)/u,
      'macOS security CLI calls must have a kill-on-timeout wrapper',
    );

    expectSourceContains(
      quotasCoordinator,
      /const controller = new AbortController\(\);[\s\S]*input\.fetcher\.fetch\([\s\S]*signal: controller\.signal[\s\S]*setTimeout\([\s\S]*controller\.abort\('quota-fetch-timeout'\)[\s\S]*Promise\.race/u,
      'provider quota fetches must race a timeout and abort the fetcher signal',
    );

    expectSourceContains(
      quotasCoordinator,
      /input\.fetcher\.consumeRecoveryCredit\([\s\S]*signal: controller\.signal[\s\S]*controller\.abort\('quota-recovery-credit-consume-timeout'\)[\s\S]*Promise\.race/u,
      'provider recovery-credit consumes must race a timeout and abort the fetcher signal',
    );

    expectSourceContains(
      codexQuotaFetcher,
      /fetch\(usageUrl,[\s\S]*signal,[\s\S]*fetch\(resetCreditsUrl,[\s\S]*signal/u,
      'Codex quota fetcher must forward the caller AbortSignal to every provider fetch',
    );

    expectSourceContains(
      claudeQuotaFetcher,
      /function fetchUsage\([\s\S]*signal: AbortSignal[\s\S]*fetch\(params\.usageUrl,[\s\S]*signal: params\.signal/u,
      'Claude quota fetcher must require and forward the caller AbortSignal',
    );
  });

  // The NEGATIVE property scan: unlike the per-leaf pins above (which validate known sites), this
  // sweep FAILS when anyone adds a NEW unbounded external wait to connected-services production
  // code. Boundedness heuristic: every network/process call must have an abort/timeout budget
  // within its surrounding statement window, or an explicit justified allowlist entry.
  it('rejects new unbounded external waits anywhere in connected-services production code', async () => {
    const files = (await Promise.all(SCAN_ROOTS.map((root) => listProductionSources(root)))).flat();
    expect(files.length).toBeGreaterThan(20);

    const violations: string[] = [];
    for (const file of files) {
      const source = blankComments(await readFile(file, 'utf8'));
      const relPath = relative(CLI_SRC_ROOT, file);

      // 1. Synchronous child processes block the daemon outright (the CLOSE-16 keychain hang class).
      if (/\bspawnSync\s*\(|\bexecFileSync\s*\(|\bexecSync\s*\(/u.test(source)) {
        violations.push(`${relPath}: synchronous child_process call — use the bounded async spawn pattern`);
      }

      // 2. Every fetch must carry an abort/timeout budget near the call.
      const fetchPattern = /(?<![.\w])fetch\s*\(/gu;
      for (const match of source.matchAll(fetchPattern)) {
        const index = match.index ?? 0;
        const context = windowAround(source, index, 4, 14);
        const bounded = /signal|abort|timeout/iu.test(context);
        const allowlisted = BOUNDED_CALL_ALLOWLIST.some(
          (entry) => relPath.endsWith(entry.file) && context.includes(entry.marker),
        );
        if (!bounded && !allowlisted) {
          violations.push(`${relPath}: fetch() without an abort/timeout budget in its statement window`);
        }
      }

      // 3. Every async child_process spawn must have kill-on-timeout handling nearby.
      const spawnPattern = /(?<![.\w])spawn\s*\(/gu;
      for (const match of source.matchAll(spawnPattern)) {
        const index = match.index ?? 0;
        const context = windowAround(source, index, 10, 30);
        const bounded = /timeout|SIGTERM|SIGKILL|\.kill\(/iu.test(context);
        const allowlisted = BOUNDED_CALL_ALLOWLIST.some(
          (entry) => relPath.endsWith(entry.file) && context.includes(entry.marker),
        );
        if (!bounded && !allowlisted) {
          violations.push(`${relPath}: spawn() without kill-on-timeout handling in its window`);
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });
});
