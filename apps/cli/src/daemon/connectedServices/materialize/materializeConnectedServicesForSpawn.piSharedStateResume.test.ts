import { lstat, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { formatPiSessionDirectoryForCwd } from '@/backends/pi/utils/piSessionFiles';
import { verifySpawnResumeReachability } from '@/daemon/connectedServices/verifySpawnResumeReachability';

import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';

/**
 * Production-faithful lifecycle coverage for shared-state Pi resume.
 *
 * These tests deliberately drive the REAL spawn entrypoint (`materializeConnectedServicesForSpawn`),
 * which materializes into a fresh `.attempts/<…>` root and then `commitAttemptRoot`s it into the final
 * materialized root. The provider-level tests (`createPiConnectedServicesMaterializer.test.ts`) call
 * the materializer directly with a pre-populated `rootDir`, so they do NOT exercise this attempt-root →
 * commit lifecycle — and in particular they can't catch the fact that for a session CREATED NATIVELY
 * the rollout lives in the native shared store (`~/.pi/agent/sessions/--<cwd>--`), which the symlink
 * points at and `commitAttemptRoot` never touches (it only renames within the materialized base).
 *
 * This is the mechanism behind the real PI resume RCA (see
 * .reviews/2026-05-29-connected-services-deep-qa-audit): a native-backed shared session must remain
 * reachable through the committed symlink, and a session with no native rollout must fail closed.
 */
describe('materializeConnectedServicesForSpawn — Pi shared-state resume lifecycle', () => {
  const cwd = '/tmp/project';
  const encodedCwd = formatPiSessionDirectoryForCwd(cwd);

  function buildSharedStatePiAccountSettings() {
    return {
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: { configMode: 'linked', stateMode: 'isolated' },
        byAgentId: { pi: { configMode: 'linked', stateMode: 'shared' } },
        acknowledgedRisksByAgentId: { pi: { sharedStatePrivacy: true } },
      },
    } as const;
  }

  function buildAnthropicTokenRecord() {
    return buildConnectedServiceCredentialRecord({
      now: Date.now(),
      serviceId: 'anthropic',
      profileId: 'work',
      kind: 'token',
      token: { token: 'sk-ant-test', providerAccountId: null, providerEmail: null },
    });
  }

  it('keeps a natively-created Pi session reachable through the committed symlink (native survives commit)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-pi-resume-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-pi-resume-server-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-pi-resume-native-'));

    // The vendor rollout already exists in the NATIVE shared store (session was created outside
    // Happier / under native auth). This is the file a resume must reach.
    const vendorResumeId = '019e696c-89cc-73cf-b4a7-56511e75557c';
    const fileName = `2026-05-27T12-32-01-297Z_${vendorResumeId}.jsonl`;
    const nativeSessionsDir = join(nativeAgentDir, 'sessions', encodedCwd);
    await mkdir(nativeSessionsDir, { recursive: true });
    await writeFile(join(nativeSessionsDir, fileName), '{"id":"native-rollout"}\n');

    const result = await materializeConnectedServicesForSpawn({
      nativeSourceAuthority: 'caller_env',
      agentId: 'pi',
      materializationKey: 'session-pi-resume-present',
      activeServerDir,
      baseDir,
      sessionDirectory: cwd,
      recordsByServiceId: new Map([['anthropic', buildAnthropicTokenRecord()]]),
      accountSettings: buildSharedStatePiAccountSettings(),
      processEnv: { HOME: tmpdir(), PI_CODING_AGENT_DIR: nativeAgentDir },
    });

    expect(result).not.toBeNull();
    const piAgentDir = result!.env.PI_CODING_AGENT_DIR;

    // After commit, the session dir is a SYMLINK into the native shared store...
    const linkedEntry = await lstat(join(piAgentDir, 'sessions', encodedCwd));
    expect(linkedEntry.isSymbolicLink()).toBe(true);
    // ...and the native rollout is reachable through the committed (renamed) path.
    await expect(
      readFile(join(piAgentDir, 'sessions', encodedCwd, fileName), 'utf8'),
    ).resolves.toBe('{"id":"native-rollout"}\n');

    // The commit must NOT clobber the native store (the symlink target).
    await expect(readFile(join(nativeSessionsDir, fileName), 'utf8')).resolves.toBe('{"id":"native-rollout"}\n');

    // The native-backed link must never displace anything into a `.local-*` orphan.
    const sessionsEntries = await readdir(join(piAgentDir, 'sessions'));
    expect(sessionsEntries.filter((name) => name.includes('.local-'))).toEqual([]);

    // End-to-end: the target-strict §2 gate proves the exact final path Pi reads → reachable.
    const gateResult = await verifySpawnResumeReachability({
      agentId: 'pi',
      vendorResumeId,
      cwd,
      materializedEnv: result!.env,
      candidatePersistedSessionFile: null,
    });
    expect(gateResult.ok).toBe(true);
  });

  it('fails closed when the vendor rollout is absent from native — no file is fabricated (the 019e696c repro)', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-pi-resume-base-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-pi-resume-server-'));
    const nativeAgentDir = await mkdtemp(join(tmpdir(), 'happier-pi-resume-native-'));

    // The native store for this cwd is alive and holds OTHER sessions, but NOT the one being resumed
    // (its isolated-era rollout was reclaimed before shared-state existed — the real RCA).
    const presentId = '019e696b-9f11-7225-9207-a5e9a4953a30';
    const missingId = '019e696c-89cc-73cf-b4a7-56511e75557c';
    const nativeSessionsDir = join(nativeAgentDir, 'sessions', encodedCwd);
    await mkdir(nativeSessionsDir, { recursive: true });
    await writeFile(join(nativeSessionsDir, `2026-05-27T12-32-01-297Z_${presentId}.jsonl`), '{"id":"other"}\n');

    const result = await materializeConnectedServicesForSpawn({
      nativeSourceAuthority: 'caller_env',
      agentId: 'pi',
      materializationKey: 'session-pi-resume-absent',
      activeServerDir,
      baseDir,
      sessionDirectory: cwd,
      recordsByServiceId: new Map([['anthropic', buildAnthropicTokenRecord()]]),
      accountSettings: buildSharedStatePiAccountSettings(),
      processEnv: { HOME: tmpdir(), PI_CODING_AGENT_DIR: nativeAgentDir },
    });

    expect(result).not.toBeNull();
    const piAgentDir = result!.env.PI_CODING_AGENT_DIR;

    // The §2 gate must fail closed for the missing id (no resume continuity is granted).
    const gateResult = await verifySpawnResumeReachability({
      agentId: 'pi',
      vendorResumeId: missingId,
      cwd,
      materializedEnv: result!.env,
      candidatePersistedSessionFile: null,
    });
    expect(gateResult.ok).toBe(false);

    // Nothing was fabricated for the missing id — native still holds only the other session, both
    // directly and through the committed link.
    await expect(
      readFile(join(piAgentDir, 'sessions', encodedCwd, `2026-05-27T12-32-01-297Z_${missingId}.jsonl`), 'utf8'),
    ).rejects.toThrow();
    const nativeEntries = await readdir(nativeSessionsDir);
    expect(nativeEntries.some((name) => name.includes(missingId))).toBe(false);
  });
});
