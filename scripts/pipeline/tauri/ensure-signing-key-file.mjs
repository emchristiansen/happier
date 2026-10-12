// @ts-check

import fs from 'node:fs';
import path from 'node:path';

/**
 * Standalone `tauri signer sign --private-key-path` conflicts with the raw-key
 * environment input. Undefined masks inherited values even when a command
 * wrapper merges this copy over process.env; Node omits them from the child.
 * The Tauri build API has a different key contract and must not use this adapter.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function createTauriSignerFileEnv(env) {
  const signerEnv = { ...env };
  for (const name of Object.keys(signerEnv)) {
    if (['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_PRIVATE_KEY'].includes(name.toUpperCase())) {
      signerEnv[name] = undefined;
    }
  }
  return signerEnv;
}

/**
 * @param {{ tmpRoot: string; keyValue: string; dryRun: boolean }} opts
 * @returns {string}
 */
export function ensureTauriSigningKeyFile(opts) {
  const raw = String(opts.keyValue ?? '').trim();
  if (!raw) return '';

  const asPath = path.resolve(raw);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) {
    return asPath;
  }

  const looksLikePath =
    raw.includes('/') ||
    raw.includes('\\') ||
    raw.startsWith('.') ||
    raw.endsWith('.key') ||
    raw.endsWith('.txt') ||
    raw.endsWith('.pem');
  const looksLikeInline =
    raw.includes('\n') || raw.includes('\\n') || raw.startsWith('untrusted comment:') || raw.includes('BEGIN ');

  if (looksLikePath && !looksLikeInline) {
    if (opts.dryRun) return asPath;
    throw new Error(`TAURI_SIGNING_PRIVATE_KEY points at a missing file path: ${raw}`);
  }

  const normalized = raw.includes('\\n') ? raw.replaceAll('\\n', '\n') : raw;
  const preservesFormatting =
    normalized.startsWith('untrusted comment:') || normalized.includes('BEGIN ');
  const collapsed = preservesFormatting ? normalized : normalized.replace(/\s+/g, '');
  const output = preservesFormatting && !collapsed.endsWith('\n') ? `${collapsed}\n` : collapsed;

  const tmpRoot = path.resolve(String(opts.tmpRoot ?? '').trim() || process.cwd());
  const outPath = path.join(tmpRoot, 'tauri.signing.key');

  if (!opts.dryRun) {
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(outPath, output, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(outPath, 0o600);
    } catch {
      // best effort
    }
  }

  return outPath;
}
