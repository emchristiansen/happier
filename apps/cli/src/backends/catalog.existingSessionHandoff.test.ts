import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCodexAgentRuntimeDescriptor, supportsExistingSessionHandoffState } from '@happier-dev/agents';
import { describe, expect, it } from 'vitest';

import { openSqliteDatabaseSync } from '@/utils/sqlite/sqliteSync';
import * as catalog from './catalog';

async function withNativeHomes(run: (root: string, env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'happier-existing-handoff-'));
  try {
    await run(root, {
      HOME: root,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      CODEX_SQLITE_HOME: join(root, 'sqlite'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeCodexIndex(env: NodeJS.ProcessEnv, id: string, rolloutPath: string): Promise<string> {
  await mkdir(env.CODEX_SQLITE_HOME!, { recursive: true });
  const path = join(env.CODEX_SQLITE_HOME!, 'state_5.sqlite');
  const database = openSqliteDatabaseSync(path);
  try {
    database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
    database.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(id, rolloutPath);
  } finally {
    database.close();
  }
  return path;
}

describe('existing-state session handoff through the catalog', () => {
  it('projects exactly the catalog existing-state hooks through shared Agent policy', () => {
    for (const entry of Object.values(catalog.AGENTS)) {
      expect(supportsExistingSessionHandoffState(entry.id), entry.id).toBe(typeof entry.resolveExistingSessionHandoffState === 'function');
    }
  });

  it('resolves Claude from the actual target transcript without changing bytes and projects the requested storage mode', async () => {
    await withNativeHomes(async (root, env) => {
      const projectId = '-replicated-original-workspace';
      const projectDir = join(env.CLAUDE_CONFIG_DIR!, 'projects', projectId);
      await mkdir(projectDir, { recursive: true });
      const transcriptPath = join(projectDir, 'claude-thread.jsonl');
      const transcript = '{"type":"user","message":{"content":"existing turn"}}\n';
      await writeFile(transcriptPath, transcript);
      const before = await stat(transcriptPath);

      const result = await catalog.resolveExistingSessionHandoffStateThroughCatalog({
        metadata: { flavor: 'claude', machineId: 'source-machine', claudeSessionId: 'claude-thread', path: '/replicated/original/workspace' },
        targetPath: join(root, 'target-workspace'),
        env,
        sessionStorageMode: 'persisted',
      });

      expect(result).toMatchObject({
        remoteSessionId: 'claude-thread',
        directSource: { kind: 'claudeConfig', configDir: env.CLAUDE_CONFIG_DIR, projectId },
        resume: { agent: 'claude', resume: 'claude-thread', directory: join(root, 'target-workspace'), transcriptStorage: 'persisted', environmentVariables: { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR } },
      });
      expect(await readFile(transcriptPath, 'utf8')).toBe(transcript);
      expect((await stat(transcriptPath)).mtimeMs).toBe(before.mtimeMs);
    });
  });

  it('rejects a Claude inferred id or source transcript when the strict target store is missing, including legacy probe bypass', async () => {
    await withNativeHomes(async (root, env) => {
      const sourceTranscript = join(root, 'source-transcript.jsonl');
      await writeFile(sourceTranscript, '{}\n');
      await expect(catalog.resolveExistingSessionHandoffStateThroughCatalog({
        metadata: { flavor: 'claude', machineId: 'source-machine', claudeSessionId: 'claude-thread', claudeTranscriptPath: sourceTranscript },
        targetPath: join(root, 'target-workspace'),
        env: { ...env, HAPPIER_CONNECTED_SERVICES_LEGACY_CLAUDE_RESTART_SAME_HOME: '1' },
      })).rejects.toMatchObject({ errorCode: 'existing_session_state_unavailable' });
    });
  });

  it('resolves Codex using the native index and the target homes while preserving runtime affinity and every byte', async () => {
    await withNativeHomes(async (root, env) => {
      const id = '019f2339-9299-7e51-b192-9751a0a03586';
      await mkdir(env.CODEX_HOME!, { recursive: true });
      const rolloutPath = join(env.CODEX_HOME!, `rollout-2026-09-07T10-00-00-${id}.jsonl`);
      await writeFile(rolloutPath, '{}\n');
      const indexPath = await writeCodexIndex(env, id, rolloutPath);
      const beforeIndex = await readFile(indexPath);
      const descriptor = buildCodexAgentRuntimeDescriptor({ backendMode: 'appServer', vendorSessionId: id, home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceGroupId: 'group-1', homePath: '/source-home', sqliteHomePath: '/source-sqlite' });

      const result = await catalog.resolveExistingSessionHandoffStateThroughCatalog({
        metadata: { flavor: 'codex', machineId: 'source-machine', codexSessionId: id, agentRuntimeDescriptorV1: descriptor },
        targetPath: join(root, 'target-workspace'),
        env,
        sessionStorageMode: 'direct',
      });

      expect(result).toMatchObject({
        remoteSessionId: id,
        directSource: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceGroupId: 'group-1', homePath: env.CODEX_HOME },
        agentRuntimeDescriptorV1: { provider: { backendMode: 'appServer', vendorSessionId: id, homePath: env.CODEX_HOME, providerExtra: { runtimeAffinity: { sqliteHomePath: env.CODEX_SQLITE_HOME } } } },
        resume: { agent: 'codex', resume: id, transcriptStorage: 'direct', codexBackendMode: 'appServer', environmentVariables: { CODEX_HOME: env.CODEX_HOME, CODEX_SQLITE_HOME: env.CODEX_SQLITE_HOME } },
      });
      expect(await readFile(indexPath)).toEqual(beforeIndex);
      expect(await readFile(rolloutPath, 'utf8')).toBe('{}\n');
    });
  });

  it('refuses to repair a stale Codex native index even when a matching rollout is present', async () => {
    await withNativeHomes(async (root, env) => {
      const id = '019f2339-9299-7e51-b192-9751a0a03586';
      await mkdir(env.CODEX_HOME!, { recursive: true });
      await writeFile(join(env.CODEX_HOME!, `rollout-2026-09-07T10-00-00-${id}.jsonl`), '{}\n');
      const indexPath = await writeCodexIndex(env, id, join(root, 'missing-rollout.jsonl'));
      const beforeIndex = await readFile(indexPath);
      await expect(catalog.resolveExistingSessionHandoffStateThroughCatalog({
        metadata: { flavor: 'codex', machineId: 'source-machine', codexSessionId: id, codexBackendMode: 'appServer' },
        targetPath: root,
        env,
      })).rejects.toMatchObject({ errorCode: 'existing_session_state_unavailable' });
      expect(await readFile(indexPath)).toEqual(beforeIndex);
    });
  });

  it('fails closed for a missing Codex index or missing native thread row without creating an index', async () => {
    await withNativeHomes(async (root, env) => {
      const metadata = { flavor: 'codex', machineId: 'source-machine', codexSessionId: 'missing-thread', codexBackendMode: 'appServer' };
      await mkdir(env.CODEX_SQLITE_HOME!, { recursive: true });
      await expect(catalog.resolveExistingSessionHandoffStateThroughCatalog({ metadata, targetPath: root, env })).rejects.toThrow(/Codex.*unreachable/i);
      await expect(stat(join(env.CODEX_SQLITE_HOME!, 'state_5.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
      const indexPath = await writeCodexIndex(env, 'other-thread', join(root, 'other-rollout.jsonl'));
      const beforeIndex = await readFile(indexPath);
      await expect(catalog.resolveExistingSessionHandoffStateThroughCatalog({ metadata, targetPath: root, env })).rejects.toThrow(/Codex.*unreachable/i);
      expect(await readFile(indexPath)).toEqual(beforeIndex);
    });
  });

  it('fails closed for providers without an existing-state handoff hook', async () => {
    await expect(catalog.resolveExistingSessionHandoffStateThroughCatalog({
      metadata: { flavor: 'opencode', machineId: 'source-machine', opencodeSessionId: 'opencode-thread' },
      targetPath: '/target-workspace',
      env: {},
    })).rejects.toThrow(/existing-state handoff.*unsupported/i);
  });
});
