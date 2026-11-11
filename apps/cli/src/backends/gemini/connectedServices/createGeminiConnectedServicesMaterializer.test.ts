import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { createGeminiConnectedServicesMaterializer } from './createGeminiConnectedServicesMaterializer';

const SESSION_ID = '12740866-141f-4f73-afab-76bd38cf2e87';
const CHAT_FILE_NAME = `session-2026-05-20T07-57-${SESSION_ID.slice(0, 8)}.jsonl`;

function buildGeminiRecord(): ConnectedServiceCredentialRecordV1 {
  const now = Date.now();
  return buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'gemini',
    profileId: 'gemini-p1',
    kind: 'oauth',
    expiresAt: now + 60_000,
    oauth: {
      accessToken: 'gemini-access',
      refreshToken: 'gemini-refresh',
      idToken: null,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      tokenType: 'Bearer',
      providerAccountId: 'google-account',
      providerEmail: 'user@example.com',
    },
  });
}

async function writeNativeGeminiChatFixture(params: Readonly<{
  homeDir: string;
  slug: string;
  cwd: string;
}>): Promise<string> {
  const chatsDir = join(params.homeDir, '.gemini', 'tmp', params.slug, 'chats');
  await mkdir(chatsDir, { recursive: true });
  const filePath = join(chatsDir, CHAT_FILE_NAME);
  await writeFile(filePath, JSON.stringify({ sessionId: SESSION_ID, kind: 'main' }), 'utf8');
  await writeFile(
    join(params.homeDir, '.gemini', 'projects.json'),
    JSON.stringify({ projects: { [params.cwd]: params.slug } }),
    'utf8',
  );
  return filePath;
}

function buildMaterializerInput(params: Readonly<{
  rootDir: string;
  sourceHome: string;
  cwd: string;
  vendorResumeId?: string | null;
}>) {
  return {
    agentId: 'gemini' as const,
    nativeSourceAuthority: 'caller_env' as const,
    activeServerDir: params.rootDir,
    rootDir: params.rootDir,
    sessionDirectory: params.cwd,
    recordsByServiceId: new Map<ConnectedServiceId, ConnectedServiceCredentialRecordV1>([
      ['gemini', buildGeminiRecord()],
    ]),
    processEnv: { HOME: params.sourceHome } as NodeJS.ProcessEnv,
    vendorResumeId: params.vendorResumeId ?? null,
    cleanupRoot: () => {},
  };
}

describe('createGeminiConnectedServicesMaterializer', () => {
  it('imports the native chat session for the resumed vendor session into the isolated home', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gemini-materializer-'));
    const sourceHome = await mkdtemp(join(tmpdir(), 'gemini-native-home-'));
    const cwd = '/workspace/my-project';
    const sourcePath = await writeNativeGeminiChatFixture({ homeDir: sourceHome, slug: 'my-project', cwd });

    const materializer = createGeminiConnectedServicesMaterializer();
    const result = await materializer(buildMaterializerInput({
      rootDir,
      sourceHome,
      cwd,
      vendorResumeId: SESSION_ID,
    }));

    expect(result).not.toBeNull();
    const destinationPath = join(rootDir, 'home', '.gemini', 'tmp', 'my-project', 'chats', CHAT_FILE_NAME);
    expect(await readFile(destinationPath, 'utf8')).toBe(await readFile(sourcePath, 'utf8'));
    const projects = JSON.parse(await readFile(join(rootDir, 'home', '.gemini', 'projects.json'), 'utf8'));
    expect(projects).toEqual({ projects: { [cwd]: 'my-project' } });
    expect(result?.diagnostics ?? []).toEqual([]);
  });

  it('emits a warning diagnostic when the resumed vendor session cannot be found at any source', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gemini-materializer-'));
    const sourceHome = await mkdtemp(join(tmpdir(), 'gemini-native-home-'));

    const materializer = createGeminiConnectedServicesMaterializer();
    const result = await materializer(buildMaterializerInput({
      rootDir,
      sourceHome,
      cwd: '/workspace/my-project',
      vendorResumeId: SESSION_ID,
    }));

    expect(result).not.toBeNull();
    expect(result?.diagnostics).toEqual([
      expect.objectContaining({
        code: 'gemini_chat_session_import_skipped',
        providerId: 'gemini',
        serviceId: 'gemini',
        severity: 'warning',
        reason: 'source_session_file_not_found',
      }),
    ]);
  });

  it('does not attempt any continuity import for fresh sessions without a vendor resume id', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'gemini-materializer-'));
    const sourceHome = await mkdtemp(join(tmpdir(), 'gemini-native-home-'));

    const materializer = createGeminiConnectedServicesMaterializer();
    const result = await materializer(buildMaterializerInput({
      rootDir,
      sourceHome,
      cwd: '/workspace/my-project',
      vendorResumeId: null,
    }));

    expect(result).not.toBeNull();
    expect(result?.diagnostics ?? []).toEqual([]);
  });
});
