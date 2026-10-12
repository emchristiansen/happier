import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { createDaemonServiceStopHandler } from './daemonService.js';

it('aggregate stop cannot target an uninstalled default service even with a running daemon', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w23-bootstrap-foreign-'));
  const cli = join(root, 'happier');
  const commands = join(root, 'commands.jsonl');
  const previousHome = process.env.HAPPIER_HOME_DIR;
  const previousCli = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
  onTestFinished(() => {
    if (previousHome === undefined) delete process.env.HAPPIER_HOME_DIR; else process.env.HAPPIER_HOME_DIR = previousHome;
    if (previousCli === undefined) delete process.env.HAPPIER_BOOTSTRAP_CLI_PATH; else process.env.HAPPIER_BOOTSTRAP_CLI_PATH = previousCli;
    rmSync(root, { recursive: true, force: true });
  });
  const status = {
    server: { activeServerId: 'cloud', serverUrl: 'https://relay.example.test', localServerUrl: null, publicServerUrl: 'https://relay.example.test', webappUrl: 'https://relay.example.test', comparableKey: 'https://relay.example.test' },
    daemon: { running: true, pid: 4321, httpPort: 7777, serviceManaged: false, serviceLabel: null },
    service: { installed: false, running: false, targetMode: null, autostart: null },
    auth: { authenticated: false, machineRegistered: false, machineId: null, needsAuth: true, accountId: null },
  };
  // A disposable CLI process is the external boundary; bootstrap executes its real orchestration.
  writeFileSync(cli, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(commands)}, JSON.stringify(args) + '\\n');\nif(args.includes('--version')) console.log('0.2.14');\nelse if(args.includes('list')) console.log(JSON.stringify({ entries: [] }));\nelse if(args.includes('status')) console.log(${JSON.stringify(JSON.stringify(status))});\nelse { console.error('foreign service mutation attempted'); process.exitCode = 1; }\n`);
  chmodSync(cli, 0o755);
  process.env.HAPPIER_HOME_DIR = root;
  process.env.HAPPIER_BOOTSTRAP_CLI_PATH = cli;
  const iterator = createDaemonServiceStopHandler()({ target: { kind: 'local' }, channel: 'stable', mode: 'user' }, { signal: new AbortController().signal });
  let result: unknown;
  for (;;) { const step = await iterator.next(); if (step.done) { result = step.value; break; } }
  expect(result).toMatchObject({ serviceInstalled: false, daemonRunning: true });
  const invocations = readFileSync(commands, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);
  expect(invocations.some((args) => args.includes('stop'))).toBe(false);
});
