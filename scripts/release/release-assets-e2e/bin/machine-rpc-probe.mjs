#!/usr/bin/env node
// INV10-equivalent reachability proof for the desktop-setup suite: one relay-routed, read-only
// `capabilities.describe` machine RPC with an empty payload — the same call the app's readiness
// proof makes through `machineRpcWithServerScope`. A machine row or a PID proves nothing here; only
// the daemon answering through the relay does.
//
// Runs on the machine under test as its user, with that machine's own saved credentials
// (`<HAPPIER_HOME_DIR>/servers/<serverId>/access.key`): the token opens a user-scoped socket for
// the account, and the dataKey `machineKey` is the key the daemon registered its machine with, so
// the RPC is encrypted exactly as a client of that account would encrypt it.
//
// Dependency-free on purpose (Node 22 global WebSocket + node:crypto): the machine has no CLI
// package to borrow modules from, only the shipped binaries under test.
//
// Usage: node machine-rpc-probe.mjs --relay-url <url> --machine-id <id> --server-id <id> [--home-dir <dir>]
// Prints one JSON line: { ok, machineId, resultKeys } and exits 0, or { ok: false, error } and exits 1.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Inherited from the server's RPC forwarding default (30 s); the probe adds no bound of its own
// beyond waiting that long for the ack.
const RPC_ACK_TIMEOUT_MS = 30_000;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? '').trim() : '';
}

function encryptDataKey(value, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()]);
  return Buffer.concat([Buffer.from([0]), nonce, body, cipher.getAuthTag()]).toString('base64');
}

function decryptDataKey(base64, key) {
  const bundle = Buffer.from(String(base64 ?? ''), 'base64');
  if (bundle.length < 29 || bundle[0] !== 0) throw new Error('rpc result is not a dataKey bundle');
  const decipher = createDecipheriv('aes-256-gcm', key, bundle.subarray(1, 13));
  decipher.setAuthTag(bundle.subarray(bundle.length - 16));
  const plain = Buffer.concat([decipher.update(bundle.subarray(13, bundle.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// Mirrors `parseSerializedJsonValue` (`packages/protocol/src/crypto/serializedJsonValue.ts`): RPC
// results may arrive wrapped in the `__happierSerializedJsonValueV1` envelope.
function unwrapSerializedJsonValue(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (parsed && typeof parsed === 'object' && parsed.__happierSerializedJsonValueV1 === true) {
    return parsed.type === 'json' ? parsed.value : undefined;
  }
  return parsed;
}

function readMachineCredentials({ homeDir, serverId }) {
  const raw = JSON.parse(readFileSync(join(homeDir, 'servers', serverId, 'access.key'), 'utf8'));
  const token = String(raw?.token ?? '').trim();
  const machineKeyB64 = String(raw?.encryption?.machineKey ?? '').trim();
  if (!token) throw new Error('machine credentials carry no token');
  if (!machineKeyB64) throw new Error('machine credentials are not dataKey credentials (no encryption.machineKey)');
  const machineKey = Buffer.from(machineKeyB64, 'base64');
  if (machineKey.length !== 32) throw new Error(`machineKey must be 32 bytes (got ${machineKey.length})`);
  return { token, machineKey };
}

/** One socket.io v4 connection over a raw WebSocket; resolves with the ack payload of one emit. */
function callOnce({ relayUrl, token, event, payload }) {
  const wsUrl = new URL('/v1/updates/', relayUrl);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.searchParams.set('EIO', '4');
  wsUrl.searchParams.set('transport', 'websocket');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const ackId = 1;
    let timer = null;
    const finish = (fn, value) => {
      if (timer) clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      fn(value);
    };
    ws.addEventListener('error', () => finish(reject, new Error(`websocket error connecting to ${wsUrl.origin}`)));
    ws.addEventListener('close', () => finish(reject, new Error('socket closed before the rpc was acknowledged')));
    ws.addEventListener('message', (message) => {
      const frame = String(message.data ?? '');
      if (frame === '2') { ws.send('3'); return; }                       // engine.io ping
      if (frame.startsWith('0')) {                                       // engine.io open
        ws.send(`40${JSON.stringify({ token, clientType: 'user-scoped', clientPurpose: 'release-validation-probe' })}`);
        return;
      }
      if (frame.startsWith('44')) { finish(reject, new Error(`relay refused the socket: ${frame.slice(2)}`)); return; }
      if (frame.startsWith('40')) {                                      // socket.io connected
        timer = setTimeout(() => finish(reject, new Error(`rpc not acknowledged within ${RPC_ACK_TIMEOUT_MS}ms`)), RPC_ACK_TIMEOUT_MS);
        ws.send(`42${ackId}${JSON.stringify([event, payload])}`);
        return;
      }
      if (frame.startsWith(`43${ackId}`)) {
        const args = JSON.parse(frame.slice(`43${ackId}`.length));
        finish(resolve, Array.isArray(args) ? args[0] : args);
      }
    });
  });
}

async function main() {
  const relayUrl = argValue('--relay-url');
  const machineId = argValue('--machine-id');
  const serverId = argValue('--server-id');
  const homeDir = argValue('--home-dir') || String(process.env.HAPPIER_HOME_DIR ?? '').trim() || join(homedir(), '.happier');
  if (!relayUrl || !machineId || !serverId) throw new Error('usage: --relay-url <url> --machine-id <id> --server-id <id>');

  const { token, machineKey } = readMachineCredentials({ homeDir, serverId });
  const response = await callOnce({
    relayUrl,
    token,
    event: 'rpc-call',
    payload: { method: `${machineId}:capabilities.describe`, params: encryptDataKey({}, machineKey) },
  });
  if (!response || response.ok !== true || typeof response.result !== 'string') {
    throw new Error(`machine rpc failed: ${JSON.stringify(response)}`);
  }
  const result = unwrapSerializedJsonValue(decryptDataKey(response.result, machineKey));
  if (!result || typeof result !== 'object' || typeof result.error === 'string') {
    throw new Error(`capabilities.describe answered with an error: ${JSON.stringify(result)}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, machineId, resultKeys: Object.keys(result).sort() })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exit(1);
});
