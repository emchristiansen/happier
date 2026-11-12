import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveBoxPublicKeyFromSeed, PromptDocBodyV1Schema } from '@happier-dev/protocol';

import { configuration, reloadConfiguration } from '@/configuration';
import { sealArtifactDataEncryptionKey } from '@/api/artifacts/artifactRecords';
import { decodeBase64, decryptWithDataKey, encodeBase64, encryptWithDataKey, getRandomBytes } from '@/api/encryption';
import { writeCredentialsDataKey, type Credentials } from '@/persistence';
import { projectPath } from '@/projectPath';
import { commandRegistry } from '@/cli/commandRegistry';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureStdout } from '@/testkit/logger/captureOutput';

// The Happier API is the only mocked boundary: a loopback HTTP server holding one artifact with the real server's
// GET /v1/artifacts/:id shape and POST /v1/artifacts/:id compare-and-set rules. It logs every request it receives,
// on any path, so a test can prove which requests a command made. Credentials and keys are synthetic and are
// loaded by the CLI's own credential reader from a temporary Happier home.

const ARTIFACT_ID = '19d69028-0000-4000-8000-000000000001';
const TOKEN = 'synthetic-token-not-a-credential';
const MACHINE_KEY = new Uint8Array(32).fill(9);
const PUBLIC_KEY = deriveBoxPublicKeyFromSeed(MACHINE_KEY);
const DATA_KEY_CREDENTIALS: Credentials = {
  token: TOKEN,
  encryption: { type: 'dataKey', publicKey: PUBLIC_KEY, machineKey: MACHINE_KEY },
};
const HEADER = { v: 1, kind: 'prompt_doc.v2', title: 'Claude Worker', folderId: null, tags: ['roles'], origin: 'user', locked: false };
const STORED_MARKDOWN = '\n\n  # Claude Worker\n\nRole body.  \n\n';
const ARTIFACT_PATH = `/v1/artifacts/${ARTIFACT_ID}`;

type StoredArtifact = {
  header: string;
  headerVersion: number;
  body: string;
  bodyVersion: number;
  dataEncryptionKey: string;
  seq: number;
};

type LoggedRequest = Readonly<{ method: string; url: string; authorization: string | null; body: unknown }>;
type CustomResponse = Readonly<{ status: number; json?: unknown; headers?: Record<string, string> }>;

const envKeys = ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_ACTIVE_SERVER_ID'] as const;
let envScope = createEnvKeyScope(envKeys);
let home = '';
let server: Server | null = null;
let serverUrl = '';
let stored: StoredArtifact;
let dataKey: Uint8Array;
let requests: LoggedRequest[] = [];
let getResponse: ((stored: StoredArtifact) => CustomResponse) | null = null;
let postResponse: (() => CustomResponse) | null = null;
let beforeUpdate: (() => void) | null = null;
let prevExitCode: typeof process.exitCode;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  req.setEncoding('utf8');
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : null;
}

/** The exact decrypted body string the server holds, i.e. what `--expected-body-sha256` covers. */
function storedBodyText(): string {
  return (decryptWithDataKey(decodeBase64(stored.body), dataKey) as { body: string }).body;
}

function storedBodySha256(): string {
  return sha256(Buffer.from(storedBodyText(), 'utf8'));
}

function encryptDoc(markdown: string, key: Uint8Array): string {
  // Deliberately not JSON.stringify's canonical spacing: the digest must cover these exact bytes.
  const bodyText = `{"v":1, "markdown":${JSON.stringify(markdown)},"createdAtMs":1000,"updatedAtMs":2000}`;
  return encodeBase64(encryptWithDataKey({ body: bodyText, extra: 'kept' }, key), 'base64');
}

function decryptStoredDoc(): unknown {
  return PromptDocBodyV1Schema.parse(JSON.parse(storedBodyText()));
}

async function seedArtifact(): Promise<void> {
  dataKey = getRandomBytes(32);
  stored = {
    header: encodeBase64(encryptWithDataKey(HEADER, dataKey), 'base64'),
    headerVersion: 3,
    body: encryptDoc(STORED_MARKDOWN, dataKey),
    bodyVersion: 7,
    dataEncryptionKey: await sealArtifactDataEncryptionKey({ credentials: DATA_KEY_CREDENTIALS, dataEncryptionKey: dataKey }),
    seq: 11,
  };
}

function artifactJson(): Record<string, unknown> {
  return { id: ARTIFACT_ID, ...stored, createdAt: 100, updatedAt: 200 };
}

async function startServer(): Promise<void> {
  server = createServer(async (req, res) => {
    const body = await readJsonBody(req);
    requests.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization ?? null, body });
    const send = (response: CustomResponse) => {
      res.writeHead(response.status, { 'content-type': 'application/json', ...response.headers });
      res.end(JSON.stringify(response.json ?? {}));
    };
    if (req.method === 'GET' && req.url === ARTIFACT_PATH) {
      return send(getResponse?.(stored) ?? { status: 200, json: artifactJson() });
    }
    if (req.method === 'POST' && req.url === ARTIFACT_PATH) {
      const custom = postResponse?.();
      if (custom) return send(custom);
      beforeUpdate?.();
      const update = body as { header?: string; expectedHeaderVersion?: number; body?: string; expectedBodyVersion?: number };
      if (update.body === undefined || update.expectedBodyVersion === undefined) {
        return send({ status: 400, json: { error: 'Invalid parameters' } });
      }
      if (update.expectedBodyVersion !== stored.bodyVersion) {
        return send({ status: 200, json: { success: false, error: 'version-mismatch', currentBodyVersion: stored.bodyVersion, currentBody: stored.body } });
      }
      stored.body = update.body;
      stored.bodyVersion += 1;
      stored.seq += 1;
      return send({ status: 200, json: { success: true, bodyVersion: stored.bodyVersion } });
    }
    return send({ status: 404, json: { error: 'not served by this test server' } });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no address');
  serverUrl = `http://127.0.0.1:${address.port}`;
}

async function runPromptDoc(args: string[]): Promise<Readonly<{ stdout: string; json: any }>> {
  const handler = commandRegistry['prompt-doc'];
  expect(handler).toBeTypeOf('function');
  const output = captureStdout();
  try {
    await handler!({ args: ['prompt-doc', ...args], rawArgv: ['prompt-doc', ...args], terminalRuntime: null });
  } finally {
    output.restore();
  }
  const stdout = output.text();
  let json: any = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { stdout, json };
}

type CliRun = Readonly<{ exitCode: number | null; stdout: Buffer; stderr: string; json: any }>;

/**
 * Runs the real CLI entry point (`src/index.ts`) in a fresh process, as `happier prompt-doc ...`. The child gets a
 * cleared environment: only PATH, a temporary HOME/Happier home and the loopback server URL.
 */
async function runCli(args: readonly string[]): Promise<CliRun> {
  const child = spawn(process.execPath, ['--import', 'tsx', join(projectPath(), 'src', 'index.ts'), 'prompt-doc', ...args], {
    cwd: projectPath(),
    env: {
      PATH: process.env.PATH ?? '',
      TMPDIR: tmpdir(),
      HOME: home,
      HAPPIER_HOME_DIR: home,
      HAPPIER_SERVER_URL: serverUrl,
      HAPPIER_WEBAPP_URL: serverUrl,
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  const out = Buffer.concat(stdout);
  let json: any = null;
  try {
    json = JSON.parse(out.toString('utf8'));
  } catch {
    json = null;
  }
  return { exitCode, stdout: out, stderr, json };
}

function artifactRequests(): string[] {
  return requests.map((request) => `${request.method} ${request.url}`);
}

beforeEach(async () => {
  prevExitCode = process.exitCode;
  process.exitCode = undefined;
  home = await createTempDir('happier-prompt-doc-');
  requests = [];
  getResponse = null;
  postResponse = null;
  beforeUpdate = null;
  await startServer();
  envScope.patch({ HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: serverUrl, HAPPIER_WEBAPP_URL: serverUrl, HAPPIER_ACTIVE_SERVER_ID: undefined });
  reloadConfiguration();
  await writeCredentialsDataKey({ token: TOKEN, publicKey: PUBLIC_KEY, machineKey: MACHINE_KEY });
  await seedArtifact();
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  envScope.restore();
  envScope = createEnvKeyScope(envKeys);
  reloadConfiguration();
  await removeTempDir(home);
  process.exitCode = prevExitCode;
});

async function writeInput(name: string, bytes: Uint8Array | string): Promise<string> {
  const path = join(home, name);
  await writeFile(path, bytes);
  return path;
}

const CLI_TIMEOUT_MS = 120_000;

describe('happier prompt-doc get', () => {
  it('returns the exact stored markdown, record versions and exact-body digest from one exact artifact request', async () => {
    const { json } = await runPromptDoc(['get', ARTIFACT_ID, '--json']);

    const bodyBytes = Buffer.from(storedBodyText(), 'utf8');
    expect(json).toMatchObject({
      ok: true,
      kind: 'prompt_doc_get',
      data: {
        artifactId: ARTIFACT_ID,
        header: HEADER,
        headerVersion: 3,
        bodyVersion: 7,
        bodySha256: sha256(bodyBytes),
        bodyBytes: bodyBytes.byteLength,
        seq: 11,
        doc: { v: 1, markdown: STORED_MARKDOWN, createdAtMs: 1_000, updatedAtMs: 2_000 },
      },
    });
    expect(process.exitCode).toBe(0);
    expect(requests).toEqual([{ method: 'GET', url: ARTIFACT_PATH, authorization: `Bearer ${TOKEN}`, body: null }]);
  });

  it('accepts an opaque non-UUID artifact id the server can hold', async () => {
    const { json } = await runPromptDoc(['get', 'prompt-doc-under-test', '--json']);

    expect(json).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(artifactRequests()).toEqual(['GET /v1/artifacts/prompt-doc-under-test']);
  });

  it.each([
    ['not_found', () => ({ status: 404, json: { error: 'Artifact not found' } }), { code: 'not_found' }],
    ['http_status', () => ({ status: 500, json: { error: 'Failed to get artifact' } }), { code: 'http_status', status: 500 }],
    ['invalid_response', () => ({ status: 200, json: { id: ARTIFACT_ID } }), { code: 'invalid_response' }],
    ['data_key_unavailable', () => ({
      status: 200,
      json: { ...artifactJson(), dataEncryptionKey: encodeBase64(new Uint8Array([0, ...getRandomBytes(80)]), 'base64') },
    }), { code: 'data_key_unavailable' }],
    ['header_decrypt_failed', (s: StoredArtifact) => {
      const corrupt = decodeBase64(s.header);
      corrupt[20] ^= 0xff;
      return { status: 200, json: { ...artifactJson(), header: encodeBase64(corrupt, 'base64') } };
    }, { code: 'header_decrypt_failed' }],
    ['header_invalid', () => ({
      status: 200,
      json: { ...artifactJson(), header: encodeBase64(encryptWithDataKey({ v: 1, kind: 'approval_request.v1', title: 'x' }, dataKey), 'base64') },
    }), { code: 'header_invalid' }],
    ['body_decrypt_failed', (s: StoredArtifact) => {
      const corrupt = decodeBase64(s.body);
      corrupt[20] ^= 0xff;
      return { status: 200, json: { ...artifactJson(), body: encodeBase64(corrupt, 'base64') } };
    }, { code: 'body_decrypt_failed' }],
    ['body_invalid', () => ({
      status: 200,
      json: { ...artifactJson(), body: encodeBase64(encryptWithDataKey({ body: JSON.stringify({ v: 2, text: 'x' }) }, dataKey), 'base64') },
    }), { code: 'body_invalid' }],
  ] as const)('classifies %s without inventing an empty document', async (_name, response, error) => {
    getResponse = response;

    const { json } = await runPromptDoc(['get', ARTIFACT_ID, '--json']);

    expect(json).toMatchObject({ ok: false, kind: 'prompt_doc_get', error });
    expect(json.data).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(artifactRequests()).toEqual([`GET ${ARTIFACT_PATH}`]);
  });

  it('classifies an unreachable server as a network failure', async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    const { json } = await runPromptDoc(['get', ARTIFACT_ID, '--json']);

    expect(json).toMatchObject({ ok: false, kind: 'prompt_doc_get', error: { code: 'network' } });
  });

  it('reports missing credentials and missing account key material without any request', async () => {
    await removeTempDir(home);
    const missing = await runPromptDoc(['get', ARTIFACT_ID, '--json']);
    expect(missing.json).toMatchObject({ ok: false, error: { code: 'not_authenticated' } });

    // The stored shape of a token-only sign-in (no account key material), as the credential reader parses it.
    await mkdir(dirname(configuration.privateKeyFile), { recursive: true });
    await writeFile(configuration.privateKeyFile, JSON.stringify({ token: TOKEN, encryption: null }), { mode: 0o600 });
    const tokenOnly = await runPromptDoc(['get', ARTIFACT_ID, '--json']);
    expect(tokenOnly.json).toMatchObject({ ok: false, error: { code: 'encryption_key_required' } });

    expect(requests).toEqual([]);
  });
});

describe('happier prompt-doc update', () => {
  it('replaces only the markdown at the expected version and digest, keeping header, key and every other body field', async () => {
    const replacement = '\n# Claude Worker\n\nRole body.\n\nCorporate paragraph.\n\n';
    const before = { header: stored.header, headerVersion: stored.headerVersion, dataEncryptionKey: stored.dataEncryptionKey };
    const previousBodySha256 = storedBodySha256();

    const { json } = await runPromptDoc([
      'update', ARTIFACT_ID, '--expected-body-version', '7', '--expected-body-sha256', previousBodySha256,
      '--markdown-file', await writeInput('replacement.md', replacement), '--json',
    ]);

    expect(json).toMatchObject({
      ok: true,
      kind: 'prompt_doc_update',
      data: { artifactId: ARTIFACT_ID, previousBodyVersion: 7, previousBodySha256, bodyVersion: 8, bodySha256: storedBodySha256() },
    });
    expect(artifactRequests()).toEqual([`GET ${ARTIFACT_PATH}`, `POST ${ARTIFACT_PATH}`]);
    expect(Object.keys(requests[1].body as object).sort()).toEqual(['body', 'expectedBodyVersion']);
    expect(requests[1].body).toMatchObject({ expectedBodyVersion: 7 });
    expect({ header: stored.header, headerVersion: stored.headerVersion, dataEncryptionKey: stored.dataEncryptionKey }).toEqual(before);
    expect((decryptWithDataKey(decodeBase64(stored.body), dataKey) as { extra: unknown }).extra).toBe('kept');
    const doc = decryptStoredDoc() as { markdown: string; createdAtMs: number; updatedAtMs: number };
    expect(doc.markdown).toBe(replacement);
    expect(doc.createdAtMs).toBe(1_000);
    expect(doc.updatedAtMs).toBeGreaterThan(2_000);
  });

  it('reports a concurrent change rejected by the server compare-and-set and does not retry over it', async () => {
    const concurrentBody = encryptDoc('concurrent edit', dataKey);
    beforeUpdate = () => {
      stored.body = concurrentBody;
      stored.bodyVersion = 8;
      beforeUpdate = null;
    };

    const { json } = await runPromptDoc([
      'update', ARTIFACT_ID, '--expected-body-version', '7', '--expected-body-sha256', storedBodySha256(),
      '--markdown-file', await writeInput('mine.md', 'mine'), '--json',
    ]);

    expect(json).toMatchObject({ ok: false, kind: 'prompt_doc_update', error: { code: 'version_mismatch', expectedBodyVersion: 7, currentBodyVersion: 8 } });
    expect(artifactRequests()).toEqual([`GET ${ARTIFACT_PATH}`, `POST ${ARTIFACT_PATH}`]);
    expect(requests[1].body).toMatchObject({ expectedBodyVersion: 7 });
    expect(stored.body).toBe(concurrentBody);
    expect((decryptStoredDoc() as { markdown: string }).markdown).toBe('concurrent edit');
  });

  it('does not write when the current document cannot be read', async () => {
    getResponse = () => ({ status: 404, json: { error: 'Artifact not found' } });

    const { json } = await runPromptDoc([
      'update', ARTIFACT_ID, '--expected-body-version', '7', '--expected-body-sha256', 'a'.repeat(64),
      '--markdown-file', await writeInput('new.md', 'new'), '--json',
    ]);

    expect(json).toMatchObject({ ok: false, kind: 'prompt_doc_update', error: { code: 'not_found' } });
    expect(artifactRequests()).toEqual([`GET ${ARTIFACT_PATH}`]);
  });
});

describe('happier prompt-doc through full CLI startup', () => {
  it.each([
    ['BOM, CRLF and outer whitespace', Buffer.from('\uFEFF  \r\n# Replacement\r\n  Tail  \r\n\n', 'utf8')],
    ['outer whitespace and CRLF without a BOM', Buffer.from('\n\t # Title\r\nBody é \r\n  ', 'utf8')],
  ])('stores and reads back the exact file text (%s) through encryption, POST and GET', async (_name, fileBytes) => {
    const expectedText = fileBytes.toString('utf8');
    expect(Buffer.from(expectedText, 'utf8').equals(fileBytes)).toBe(true);
    const previousBodySha256 = storedBodySha256();

    const update = await runCli([
      'update', ARTIFACT_ID, '--expected-body-version', '7', '--expected-body-sha256', previousBodySha256,
      '--markdown-file', await writeInput('replacement.md', fileBytes), '--json',
    ]);

    expect(update.exitCode).toBe(0);
    expect(update.json).toMatchObject({ ok: true, data: { previousBodyVersion: 7, previousBodySha256, bodyVersion: 8 } });
    expect(artifactRequests()).toEqual([`GET ${ARTIFACT_PATH}`, `POST ${ARTIFACT_PATH}`]);
    expect(Buffer.from((decryptStoredDoc() as { markdown: string }).markdown, 'utf8').equals(fileBytes)).toBe(true);

    requests = [];
    const raw = await runCli(['get', ARTIFACT_ID]);
    expect(raw.exitCode).toBe(0);
    expect(raw.stdout.equals(fileBytes)).toBe(true);

    const readback = await runCli(['get', ARTIFACT_ID, '--json']);
    expect(readback.exitCode).toBe(0);
    expect(readback.json.data).toMatchObject({ bodyVersion: 8, bodySha256: update.json.data.bodySha256, doc: { markdown: expectedText } });
    expect(artifactRequests()).toEqual([`GET ${ARTIFACT_PATH}`, `GET ${ARTIFACT_PATH}`]);
  }, CLI_TIMEOUT_MS);

  const SHA = 'b'.repeat(64);
  it.each([
    ['a dot-segment selector', ['get', '..', '--json']],
    ['a single-dot selector', ['get', '.', '--json']],
    ['a selector with surrounding whitespace', ['get', ` ${ARTIFACT_ID}`, '--json']],
    ['a missing selector', ['get', '--json']],
    ['an extra positional', ['get', ARTIFACT_ID, 'other', '--json']],
    ['an unsupported selector flag on get', ['get', '--artifact-id', ARTIFACT_ID, '--json']],
    ['an unsupported selector flag on update', ['update', '--artifact-id', ARTIFACT_ID, '--expected-body-version', '7', '--expected-body-sha256', SHA, '--markdown-file', 'x.md', '--json']],
    ['an option terminator', ['get', '--', ARTIFACT_ID, '--json']],
    ['a duplicated --json', ['get', ARTIFACT_ID, '--json', '--json']],
    ['a duplicated version', ['update', ARTIFACT_ID, '--expected-body-version', '7', '--expected-body-version', '7', '--expected-body-sha256', SHA, '--markdown-file', 'x.md', '--json']],
    ['an inline option value', ['update', ARTIFACT_ID, '--expected-body-version=7', '--expected-body-sha256', SHA, '--markdown-file', 'x.md', '--json']],
    ['a non-integer version', ['update', ARTIFACT_ID, '--expected-body-version', '7.0', '--expected-body-sha256', SHA, '--markdown-file', 'x.md', '--json']],
    ['a padded version', ['update', ARTIFACT_ID, '--expected-body-version', ' 7', '--expected-body-sha256', SHA, '--markdown-file', 'x.md', '--json']],
    ['a negative version', ['update', ARTIFACT_ID, '--expected-body-version', '-1', '--expected-body-sha256', SHA, '--markdown-file', 'x.md', '--json']],
    ['a leading-zero version', ['update', ARTIFACT_ID, '--expected-body-version', '07', '--expected-body-sha256', SHA, '--markdown-file', 'x.md', '--json']],
    ['a missing digest', ['update', ARTIFACT_ID, '--expected-body-version', '7', '--markdown-file', 'x.md', '--json']],
    ['an uppercase digest', ['update', ARTIFACT_ID, '--expected-body-version', '7', '--expected-body-sha256', SHA.toUpperCase(), '--markdown-file', 'x.md', '--json']],
    ['a short digest', ['update', ARTIFACT_ID, '--expected-body-version', '7', '--expected-body-sha256', 'abc', '--markdown-file', 'x.md', '--json']],
    ['an option where the file value belongs', ['update', ARTIFACT_ID, '--expected-body-version', '7', '--expected-body-sha256', SHA, '--markdown-file', '--json']],
    ['an unknown subcommand', ['put', ARTIFACT_ID, '--json']],
  ])('refuses %s with invalid_arguments and no request', async (_name, args) => {
    const result = await runCli(args);

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(requests).toEqual([]);
  }, CLI_TIMEOUT_MS);

  it.each([
    ['a missing file', 'does-not-exist.md', 'ENOENT'],
    ['a directory', '.', 'EISDIR'],
  ])('reports %s as a structured markdown_file_unreadable failure with no request', async (_name, file, reason) => {
    const path = join(home, file);
    const result = await runCli([
      'update', ARTIFACT_ID, '--expected-body-version', '7', '--expected-body-sha256', SHA, '--markdown-file', path, '--json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.json).toEqual({
      v: 1, ok: false, kind: 'prompt_doc_update',
      error: { code: 'markdown_file_unreadable', path, reason, message: `Cannot read --markdown-file: ${path}` },
    });
    expect(requests).toEqual([]);
  }, CLI_TIMEOUT_MS);

  it('refuses a file that is not valid UTF-8 with no request', async () => {
    const path = await writeInput('invalid.md', new Uint8Array([0x23, 0x20, 0xc3, 0x28, 0x0a]));

    const result = await runCli([
      'update', ARTIFACT_ID, '--expected-body-version', '7', '--expected-body-sha256', SHA, '--markdown-file', path, '--json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ ok: false, error: { code: 'invalid_arguments', message: expect.stringContaining('not valid UTF-8') } });
    expect(requests).toEqual([]);
  }, CLI_TIMEOUT_MS);

  it.each([
    ['an expected digest of a different body', '7', () => sha256(Buffer.from(`${storedBodyText()} `, 'utf8')), { code: 'body_sha256_mismatch', bodyVersion: 7 }],
    ['an expected version that is not current', '6', () => storedBodySha256(), { code: 'version_mismatch', expectedBodyVersion: 6, currentBodyVersion: 7 }],
  ])('refuses %s after the read and sends no POST', async (_name, version, digest, error) => {
    const original = stored.body;

    const result = await runCli([
      'update', ARTIFACT_ID, '--expected-body-version', version, '--expected-body-sha256', digest(),
      '--markdown-file', await writeInput('new.md', 'new'), '--json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ ok: false, kind: 'prompt_doc_update', error });
    expect(artifactRequests()).toEqual([`GET ${ARTIFACT_PATH}`]);
    expect(stored.body).toBe(original);
  }, CLI_TIMEOUT_MS);

  it.each([302, 307])('reports a GET %s redirect without following it', async (status) => {
    getResponse = () => ({ status, headers: { location: '/v1/account/settings' } });

    const result = await runCli(['get', ARTIFACT_ID, '--json']);

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ ok: false, error: { code: 'http_status', status } });
    expect(artifactRequests()).toEqual([`GET ${ARTIFACT_PATH}`]);
  }, CLI_TIMEOUT_MS);

  it.each([307, 308])('reports a POST %s redirect without forwarding the encrypted body', async (status) => {
    postResponse = () => ({ status, headers: { location: '/v1/artifacts/another-artifact' } });
    const original = stored.body;

    const result = await runCli([
      'update', ARTIFACT_ID, '--expected-body-version', '7', '--expected-body-sha256', storedBodySha256(),
      '--markdown-file', await writeInput('new.md', 'new'), '--json',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ ok: false, kind: 'prompt_doc_update', error: { code: 'http_status', status } });
    expect(artifactRequests()).toEqual([`GET ${ARTIFACT_PATH}`, `POST ${ARTIFACT_PATH}`]);
    expect(stored.body).toBe(original);
  }, CLI_TIMEOUT_MS);
});
