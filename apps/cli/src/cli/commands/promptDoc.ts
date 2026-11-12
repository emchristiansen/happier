import { readFile } from 'node:fs/promises';

import { cmd, fail } from '@happier-dev/cli-common/output';

import type { CommandContext } from '@/cli/commandRegistry';
import { printJsonEnvelope, wantsJson } from '@/cli/output/jsonEnvelope';
import { isArtifactBodySha256 } from '@/agent/promptLibrary/artifactBodyDigest';
import {
  readPromptDocArtifact,
  updatePromptDocMarkdown,
  type PromptDocUpdateError,
} from '@/agent/promptLibrary/promptDocArtifacts';
import { isArtifactRecordId } from '@/api/artifacts/artifactRecords';
import { readCredentials, type Credentials } from '@/persistence';

export const PROMPT_DOC_USAGE = [
  'happier prompt-doc get <artifact-id> [--json]',
  'happier prompt-doc update <artifact-id> --expected-body-version <n> --expected-body-sha256 <hex> --markdown-file <path> [--json]',
].join('\n');

const BOOLEAN_FLAGS = ['--json', '--help', '-h'] as const;
const UPDATE_VALUE_FLAGS = ['--expected-body-version', '--expected-body-sha256', '--markdown-file'] as const;

type UpdateValueFlag = (typeof UPDATE_VALUE_FLAGS)[number];

type PromptDocInvocation =
  | Readonly<{ command: 'help' }>
  | Readonly<{ command: 'get'; artifactId: string }>
  | Readonly<{
      command: 'update';
      artifactId: string;
      expectedBodyVersion: number;
      expectedBodySha256: string;
      markdownFile: string;
    }>;

type PromptDocCommandDeps = Readonly<{ readCredentialsFn: () => Promise<Credentials | null> }>;

type CommandFailure = Readonly<{ code: string } & Record<string, unknown>>;

class PromptDocUsageError extends Error {}

class PromptDocInputError extends Error {
  constructor(readonly failure: CommandFailure) {
    super(String(failure.message ?? failure.code));
  }
}

/**
 * Parses the complete supported grammar before any file, credential or network access. Every token must be
 * consumed: unknown or repeated options, extra positionals, `--name=value` forms and option-like or empty
 * values are refused rather than skipped, so a malformed invocation can never select a different artifact.
 */
function parsePromptDocInvocation(argv: readonly string[]): PromptDocInvocation {
  const subcommand = argv[0];
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') return { command: 'help' };
  if (subcommand !== 'get' && subcommand !== 'update') {
    throw new PromptDocUsageError(`Unknown prompt-doc command: ${subcommand}`);
  }

  const valueFlags: readonly string[] = subcommand === 'update' ? UPDATE_VALUE_FLAGS : [];
  const seenFlags = new Set<string>();
  const values = new Map<UpdateValueFlag, string>();
  let artifactId: string | null = null;

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('-')) {
      if (seenFlags.has(token)) throw new PromptDocUsageError(`${token} may be given only once.`);
      if ((BOOLEAN_FLAGS as readonly string[]).includes(token)) {
        seenFlags.add(token);
        continue;
      }
      if (!valueFlags.includes(token)) throw new PromptDocUsageError(`Unknown option for prompt-doc ${subcommand}: ${token}`);
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('-')) {
        throw new PromptDocUsageError(`${token} requires a value.`);
      }
      seenFlags.add(token);
      values.set(token as UpdateValueFlag, value);
      index += 1;
      continue;
    }
    if (artifactId !== null) throw new PromptDocUsageError(`Unexpected argument: ${token}`);
    if (!isArtifactRecordId(token)) throw new PromptDocUsageError(`Invalid artifact id: ${JSON.stringify(token)}`);
    artifactId = token;
  }

  if (seenFlags.has('--help') || seenFlags.has('-h')) return { command: 'help' };
  if (artifactId === null) throw new PromptDocUsageError('An artifact id is required.');
  if (subcommand === 'get') return { command: 'get', artifactId };

  const rawVersion = values.get('--expected-body-version');
  const expectedBodySha256 = values.get('--expected-body-sha256');
  const markdownFile = values.get('--markdown-file');
  if (rawVersion === undefined || expectedBodySha256 === undefined || markdownFile === undefined) {
    throw new PromptDocUsageError('--expected-body-version, --expected-body-sha256 and --markdown-file are required.');
  }
  const expectedBodyVersion = /^(0|[1-9][0-9]*)$/.test(rawVersion) ? Number(rawVersion) : Number.NaN;
  if (!Number.isSafeInteger(expectedBodyVersion)) {
    throw new PromptDocUsageError('--expected-body-version must be a non-negative integer.');
  }
  if (!isArtifactBodySha256(expectedBodySha256)) {
    throw new PromptDocUsageError('--expected-body-sha256 must be 64 lowercase hexadecimal characters.');
  }
  return { command: 'update', artifactId, expectedBodyVersion, expectedBodySha256, markdownFile };
}

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

async function reportFailure(kind: string, json: boolean, error: CommandFailure): Promise<void> {
  if (json) {
    await printJsonEnvelope({ ok: false, kind, error });
    return;
  }
  const { code, ...details } = error;
  const detailText = Object.entries(details)
    .filter(([key]) => key !== 'cause')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
  console.error(fail(`prompt-doc failed: ${code}${detailText ? ` (${detailText})` : ''}`));
  process.exitCode = 1;
}

function withoutCause(error: PromptDocUpdateError): CommandFailure {
  if (error.code !== 'network') return error;
  return { code: error.code, message: error.message };
}

/** Reads the replacement exactly: a leading BOM, CRLF and outer whitespace are kept; invalid UTF-8 is refused. */
async function readMarkdownFile(path: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const reason = (error as { code?: unknown } | null)?.code;
    throw new PromptDocInputError({
      code: 'markdown_file_unreadable',
      path,
      reason: typeof reason === 'string' ? reason : 'unknown',
      message: `Cannot read --markdown-file: ${path}`,
    });
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new PromptDocUsageError(`--markdown-file is not valid UTF-8: ${path}`);
  }
}

async function cmdPromptDocGet(artifactId: string, credentials: Credentials, json: boolean): Promise<void> {
  const read = await readPromptDocArtifact({ credentials, artifactId });
  if (!read.ok) {
    await reportFailure('prompt_doc_get', json, withoutCause(read.error));
    return;
  }
  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'prompt_doc_get', data: read.artifact });
    return;
  }
  await writeStdout(read.artifact.doc.markdown);
}

async function cmdPromptDocUpdate(
  input: Extract<PromptDocInvocation, { command: 'update' }> & Readonly<{ markdown: string }>,
  credentials: Credentials,
  json: boolean,
): Promise<void> {
  const updated = await updatePromptDocMarkdown({
    credentials,
    artifactId: input.artifactId,
    expectedBodyVersion: input.expectedBodyVersion,
    expectedBodySha256: input.expectedBodySha256,
    markdown: input.markdown,
    nowMs: Date.now(),
  });
  if (!updated.ok) {
    await reportFailure('prompt_doc_update', json, withoutCause(updated.error));
    return;
  }
  const { ok: _ok, ...data } = updated;
  if (json) {
    await printJsonEnvelope({ ok: true, kind: 'prompt_doc_update', data });
    return;
  }
  console.log(`prompt doc ${data.artifactId} updated: body version ${data.previousBodyVersion} -> ${data.bodyVersion} (sha256 ${data.bodySha256})`);
}

export async function handlePromptDocCommand(
  argv: readonly string[],
  deps: PromptDocCommandDeps = { readCredentialsFn: readCredentials },
): Promise<void> {
  const json = wantsJson(argv);
  const kind = argv[0] === 'get' ? 'prompt_doc_get' : argv[0] === 'update' ? 'prompt_doc_update' : 'prompt_doc_unknown';

  try {
    const invocation = parsePromptDocInvocation(argv);
    if (invocation.command === 'help') {
      console.log(PROMPT_DOC_USAGE);
      return;
    }
    // The replacement is read before credentials so that every input failure precedes any protected request.
    const input = invocation.command === 'update'
      ? { ...invocation, markdown: await readMarkdownFile(invocation.markdownFile) }
      : invocation;

    const credentials = await deps.readCredentialsFn();
    if (!credentials) {
      if (json) {
        await printJsonEnvelope({ ok: false, kind, error: { code: 'not_authenticated' } });
        return;
      }
      console.error(fail(`Not signed in. Run ${cmd('happier auth login')} first.`));
      process.exitCode = 1;
      return;
    }

    if (input.command === 'get') await cmdPromptDocGet(input.artifactId, credentials, json);
    else await cmdPromptDocUpdate(input, credentials, json);
  } catch (error) {
    if (error instanceof PromptDocInputError) {
      await reportFailure(kind, json, error.failure);
      return;
    }
    if (!(error instanceof PromptDocUsageError)) throw error;
    if (json) {
      await printJsonEnvelope({ ok: false, kind, error: { code: 'invalid_arguments', message: error.message } });
      return;
    }
    console.error(fail(`${error.message}\nUsage:\n${PROMPT_DOC_USAGE}`));
    process.exitCode = 1;
  }
}

export async function handlePromptDocCliCommand(context: CommandContext): Promise<void> {
  await handlePromptDocCommand(context.args.slice(1));
}
