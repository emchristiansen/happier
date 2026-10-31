import { HAPPIER_RUNTIME_CONTEXT_ENV_KEYS } from './resolveHappierRuntimeContextEnv';

type RuntimeContextEnv = Partial<Record<typeof HAPPIER_RUNTIME_CONTEXT_ENV_KEYS[number], string>>;

const RUNTIME_CONTEXT_FLAG = '--runtime-context';

function invalidContext(): Error {
  // Never include a supplied payload or decoded value in a startup diagnostic.
  return new Error('Invalid --runtime-context payload');
}

function decodeRuntimeContext(value: string | undefined): RuntimeContextEnv {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidContext();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw invalidContext();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalidContext();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidContext();
  const context: RuntimeContextEnv = {};
  for (const [key, entry] of Object.entries(parsed)) {
    const contextKey = HAPPIER_RUNTIME_CONTEXT_ENV_KEYS.find((candidate) => candidate === key);
    if (!contextKey || typeof entry !== 'string' || entry.includes('\0')) throw invalidContext();
    if (contextKey.endsWith('_URL')) {
      let url: URL;
      try {
        url = new URL(entry);
      } catch {
        throw invalidContext();
      }
      // Encoding is not redaction: credential-bearing URLs must never enter saved argv.
      if (url.username || url.password) throw invalidContext();
    }
    context[contextKey] = entry;
  }
  return context;
}

/** A command prefix only: identically named provider arguments remain provider-owned. */
export function parseRuntimeContextPrefixArgs(argv: readonly string[]): Readonly<{
  args: string[];
  context: RuntimeContextEnv | null;
}> {
  if (argv[0] !== RUNTIME_CONTEXT_FLAG) return { args: [...argv], context: null };
  const context = decodeRuntimeContext(argv[1]);
  return { args: [...argv.slice(2)], context };
}

export function createRuntimeContextPrefixArgs(context: Readonly<Record<string, string>>): string[] {
  const payload = Buffer.from(JSON.stringify(context), 'utf8').toString('base64url');
  // The same boundary validates producers and consumers; arbitrary environment replay is forbidden.
  decodeRuntimeContext(payload);
  return [RUNTIME_CONTEXT_FLAG, payload];
}

export function applyRuntimeContextPrefixEnv(argv: readonly string[], env: NodeJS.ProcessEnv): void {
  const { context } = parseRuntimeContextPrefixArgs(argv);
  if (!context) return;
  for (const key of HAPPIER_RUNTIME_CONTEXT_ENV_KEYS) {
    if (context[key] === undefined) delete env[key];
    else env[key] = context[key];
  }
}
