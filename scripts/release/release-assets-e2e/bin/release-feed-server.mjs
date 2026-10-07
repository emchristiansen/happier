#!/usr/bin/env node
// Test-only stand-in for the GitHub release API that desktop setup reads (desktop-setup suite).
//
// hsetup resolves the managed CLI at `https://api.github.com/repos/<repo>/releases/tags/cli-*` and
// downloads the assets that release lists. In the suite's compose network this container answers
// for `api.github.com` (network alias + a test CA the suite passes through NODE_EXTRA_CA_CERTS), so
// the shipped binary acquires exactly the release assets staged under FEED_ROOT/stages/<stage> while
// still verifying them against the minisign key embedded in the build. Nothing here signs or alters
// an asset: a stage that is not signed by the key the binary trusts fails verification, as it must.
//
// FEED_ROOT/current names the stage served now; the suite rewrites it between upgrade steps.
// Every request is appended to FEED_ROOT/requests.log (JSON lines) for the suite's assertions.

import { createReadStream, existsSync, readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { join } from 'node:path';

const feedRoot = String(process.env.FEED_ROOT ?? '/feed').trim();
const tlsDir = String(process.env.FEED_TLS_DIR ?? join(feedRoot, 'tls')).trim();
const port = Number(process.env.FEED_PORT ?? 443);
const publicOrigin = String(process.env.FEED_PUBLIC_ORIGIN ?? 'https://api.github.com').replace(/\/+$/u, '');
const requestLogPath = join(feedRoot, 'requests.log');
const STAGE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u;
const TAG_ROUTE_RE = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/([^/?#]+)$/u;
const ASSET_ROUTE_RE = /^\/_feed\/assets\/([^/?#]+)\/([^/?#]+)$/u;

function readCurrentStage() {
  const stage = readFileSync(join(feedRoot, 'current'), 'utf8').trim();
  if (!STAGE_NAME_RE.test(stage)) throw new Error(`invalid feed stage: ${stage}`);
  return stage;
}

function listStageAssets(stage) {
  const dir = join(feedRoot, 'stages', stage);
  return readdirSync(dir)
    .filter((name) => ASSET_NAME_RE.test(name) && statSync(join(dir, name)).isFile())
    .sort();
}

function logRequest(entry) {
  appendFileSync(requestLogPath, `${JSON.stringify({ tsMs: Date.now(), ...entry })}\n`);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = createServer({
  key: readFileSync(join(tlsDir, 'server.key')),
  cert: readFileSync(join(tlsDir, 'server.crt')),
}, (req, res) => {
  const url = new URL(req.url ?? '/', 'https://feed.invalid');
  const remote = req.socket.remoteAddress ?? null;
  try {
    const tagMatch = TAG_ROUTE_RE.exec(url.pathname);
    if (req.method === 'GET' && tagMatch) {
      const tag = decodeURIComponent(tagMatch[1]);
      // Only CLI releases are staged. Any other component must not silently receive CLI assets.
      if (!tag.startsWith('cli-')) {
        logRequest({ kind: 'release', tag, status: 404, remote });
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const stage = readCurrentStage();
      const assets = listStageAssets(stage).map((name) => ({
        name,
        browser_download_url: `${publicOrigin}/_feed/assets/${stage}/${encodeURIComponent(name)}`,
      }));
      logRequest({ kind: 'release', tag, stage, status: 200, remote });
      sendJson(res, 200, { tag_name: tag, name: tag, assets });
      return;
    }

    const assetMatch = ASSET_ROUTE_RE.exec(url.pathname);
    if (req.method === 'GET' && assetMatch) {
      const stage = decodeURIComponent(assetMatch[1]);
      const name = decodeURIComponent(assetMatch[2]);
      const path = join(feedRoot, 'stages', stage, name);
      if (!STAGE_NAME_RE.test(stage) || !ASSET_NAME_RE.test(name) || !existsSync(path)) {
        logRequest({ kind: 'asset', stage, name, status: 404, remote });
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      const size = statSync(path).size;
      logRequest({ kind: 'asset', stage, name, status: 200, size, remote });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(size) });
      createReadStream(path).pipe(res);
      return;
    }

    logRequest({ kind: 'other', method: req.method, path: url.pathname, status: 404, remote });
    sendJson(res, 404, { message: 'Not Found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logRequest({ kind: 'error', path: url.pathname, status: 500, message, remote });
    sendJson(res, 500, { message });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[release-feed] serving ${feedRoot} on :${port} as ${publicOrigin}`);
});
