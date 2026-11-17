import { randomBytes, createHash } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import tweetnacl from 'tweetnacl';

import { encodeBase64, encodeBase64Url } from '@/api/encryption';
import { writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { configuration } from '@/configuration';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { buildConfigureServerLinks, buildTerminalConnectLinks } from '@happier-dev/cli-common/links';
import {
  createTerminalPairingAuthentication,
  applyTerminalAuthRequestExpiry,
  formatTerminalPairingExpiryNotice,
  readTerminalPairingRequirement,
} from '@/auth/terminalProvisioningResponse';
import { postTerminalAuthRequestCompatible } from '@/auth/terminalAuthRequest';

function sha256Base64Url(input: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(input)).digest('base64url');
}

function pendingAuthStateDir(): string {
  return join(configuration.activeServerDir, 'auth', 'pending');
}

function pendingAuthStatePath(publicKey: Uint8Array): string {
  const publicKeyHex = createHash('sha256').update(Buffer.from(publicKey)).digest('hex').slice(0, 24);
  return join(pendingAuthStateDir(), `${publicKeyHex}.json`);
}

// The public record of one request: written beside its pending state before the request is sent, so a caller
// whose request may have reached the server (lost response, killed process, lost output) still knows its
// public key. It holds no secret.
export function pendingAuthOccurrencePath(statePath: string): string {
  return statePath.replace(/\.json$/, '.request.json');
}

// fsyncs a directory, so an entry created or renamed in it survives a crash. No-op on Windows.
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Creates `dir` (0700) and syncs every directory from it up to the home, so the path itself is durable.
async function ensureDurableDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const home = configuration.happyHomeDir;
  const below = relative(home, dir);
  const chain = [dir];
  if (below && !below.startsWith('..')) {
    let current = dir;
    while (current !== home && dirname(current) !== current) {
      current = dirname(current);
      chain.push(current);
    }
  }
  for (const entry of chain) await syncDirectory(entry);
}

// Replaces `path` atomically and durably: a fresh temporary file in the same directory (mode set before any byte
// is written), fsynced, renamed over `path`, then the directory fsynced. A failure leaves `path` as it was.
async function writeFileDurably(path: string, text: string, mode: number): Promise<void> {
  const dir = dirname(path);
  const temporary = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await syncDirectory(dir);
}

export async function handleAuthRequest(args: string[]): Promise<void> {
  args = await applyServerSelectionFromArgs(args);

  const json = args.includes('--json');
  if (!json) {
    console.error('Missing required flag: --json');
    process.exit(2);
  }

  const secret = new Uint8Array(randomBytes(32));
  const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);
  const claimSecret = new Uint8Array(randomBytes(32));
  const claimSecretB64Url = Buffer.from(claimSecret).toString('base64url');
  const claimSecretHash = sha256Base64Url(claimSecret);
  const pairingRequirement = readTerminalPairingRequirement();
  let pairing = createTerminalPairingAuthentication({
    nowMs: Date.now(),
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
  });
  const pairingSecretB64Url = Buffer.from(pairing.secret).toString('base64url');

  const publicKeyB64 = encodeBase64(keypair.publicKey);
  const publicKeyB64Url = encodeBase64Url(keypair.publicKey);
  const createdAt = new Date().toISOString();
  const statePath = pendingAuthStatePath(keypair.publicKey);
  const occurrencePath = pendingAuthOccurrencePath(statePath);
  const stateText = () =>
    JSON.stringify(
      {
        publicKey: publicKeyB64,
        secretKey: encodeBase64(keypair.secretKey),
        claimSecret: claimSecretB64Url,
        pairingSecret: pairingSecretB64Url,
        pairingCreatedAtMs: pairing.createdAtMs,
        pairingExpiresAtMs: pairing.expiresAtMs,
        ...(pairingRequirement ? { pairingRequirement } : {}),
        createdAt,
      },
      null,
      2,
    );

  // Before anything is sent: the pending state (what `auth wait --public-key` needs to finish or settle this
  // request; its pairing expiry is the local one, which the server's can only shorten), then the public
  // occurrence record. Both are durable once written. If either cannot be written, nothing is sent.
  await ensureDurableDirectory(pendingAuthStateDir());
  await writeFileDurably(statePath, stateText(), 0o600);
  await writeFileDurably(
    occurrencePath,
    JSON.stringify(
      {
        publicKey: publicKeyB64,
        publicKeyB64Url,
        serverId: configuration.activeServerId,
        serverUrl: configuration.serverUrl,
        stateFile: basename(statePath),
        createdAt,
      },
      null,
      2,
    ),
    0o600,
  );

  let response: Awaited<ReturnType<typeof postTerminalAuthRequestCompatible>>;
  try {
    response = await postTerminalAuthRequestCompatible({
      serverUrl: configuration.apiServerUrl,
      publicKey: publicKeyB64,
      supportsV2: true,
      supportsTokenOnly: true,
      claimSecretHash,
    });
  } catch (error) {
    // The request may have reached the server. Its state and public record stay, for `auth wait`.
    console.error(
      `Authentication request outcome unknown: it may have reached the server. Its pending state is kept; its public record is ${occurrencePath}.`,
    );
    throw error;
  }
  pairing = applyTerminalAuthRequestExpiry(pairing, response);
  // The server's expiry, when it gave one, is now in the state. A failure here leaves the earlier state, which
  // is still valid for `auth wait`.
  await writeFileDurably(statePath, stateText(), 0o600);

  const configureLinks = buildConfigureServerLinks({
    webappUrl: configuration.webappUrl,
    serverUrl: configuration.publicServerUrl,
  });
  const terminalLinks = buildTerminalConnectLinks({
    webappUrl: configuration.webappUrl,
    serverUrl: configuration.publicServerUrl,
    publicKeyB64Url,
    pairing: {
      secretB64Url: pairingSecretB64Url,
      createdAtMs: pairing.createdAtMs,
      expiresAtMs: pairing.expiresAtMs,
    },
  });

  await writeJsonStdout({
    expiresAtMs: pairing.requestExpiresAtMs ?? null,
    expiryNotice: formatTerminalPairingExpiryNotice(pairing),
    publicKey: publicKeyB64,
    publicKeyB64Url,
    claimSecret: claimSecretB64Url,
    pairing: {
      secretB64Url: pairingSecretB64Url,
      createdAtMs: pairing.createdAtMs,
      expiresAtMs: pairing.expiresAtMs,
    },
    pairingRequirement: pairingRequirement ?? 'compatible',
    serverId: configuration.activeServerId,
    serverUrl: configuration.serverUrl,
    publicServerUrl: configuration.publicServerUrl,
    webappUrl: configuration.webappUrl,
    links: {
      configureWebUrl: configureLinks.webUrl,
      configureMobileUrl: configureLinks.mobileUrl,
      webUrl: terminalLinks.webUrl,
      mobileUrl: terminalLinks.mobileUrl,
    },
    stateFile: statePath,
    occurrenceFile: occurrencePath,
  });
}
