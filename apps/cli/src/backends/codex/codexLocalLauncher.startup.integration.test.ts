import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import { createExecutableShim } from '@/testkit/fs/executableShim';
import { removeTempDir, withTempDir } from '@/testkit/fs/tempDir';
import { serializeConnectedServiceChildSelections } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { codexLocalLauncher } from './codexLocalLauncher';
import { createLocalMessageQueue, createLocalSessionHarness } from './codexLocalLauncher.testkit';

describe('managed Codex TUI startup', () => {
  it.each(['default', 'profile', 'profile-cli-override'] as const)('preserves the %s native TUI launch while initializing only app-server configuration resources', async variant => {
    await withTempDir('happier-codex-tui-startup-', async root => {
      const home = join(root, 'home');
      await mkdir(home);
      const profileSqlite = join(home, 'profile-sqlite');
      if (variant !== 'default') await writeFile(join(home, 'focused.config.toml'), 'sqlite_home = "profile-sqlite"\n');
      const script = join(root, 'codex.cjs');
      await writeFile(script, `
        const fs = require('node:fs');
        const path = require('node:path');
        const initialized = path.join(process.env.CODEX_HOME, 'native-initialized');
        if (process.argv.includes('app-server')) {
          require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
            const request = JSON.parse(line);
            if (request.method === 'initialize') {
              fs.writeFileSync(path.join(process.env.CODEX_HOME, 'bootstrap-argv.json'), JSON.stringify(process.argv));
              fs.appendFileSync(path.join(process.env.CODEX_HOME, 'bootstrap-starts.jsonl'), JSON.stringify(process.argv) + '\\n');
              const override = process.argv.filter(arg => arg.startsWith('sqlite_home=')).at(-1);
              if (override) {
                const sqlite = path.resolve(process.cwd(), JSON.parse(override.slice('sqlite_home='.length)));
                fs.mkdirSync(sqlite, { recursive: true });
                fs.writeFileSync(path.join(sqlite, 'native-initialized'), 'ready');
              }
              fs.writeFileSync(initialized, 'ready');
              process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n');
            } else if (request.method === 'initialized') {
              fs.writeFileSync(initialized, 'ready');
            }
          });
        } else {
          fs.writeFileSync(path.join(process.env.CODEX_HOME, 'tui-start.json'), JSON.stringify({
            baselineInitialized: fs.existsSync(initialized),
            initialized: fs.existsSync(initialized) && (${variant === 'profile'} ? fs.existsSync(${JSON.stringify(join(profileSqlite, 'native-initialized'))}) : true), argv: process.argv,
          }));
          process.exit(0);
        }
      `);
      const executable = await createExecutableShim({
        dirPrefix: 'happier-codex-tui-startup-bin-',
        fileName: process.platform === 'win32' ? 'codex.cmd' : 'codex',
        contents: process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      });
      vi.stubEnv('CODEX_HOME', home);
      vi.stubEnv('HAPPIER_CODEX_TUI_BIN', executable);
      // A TUI launch must warm its own executable, not an unrelated app-server override.
      vi.stubEnv('HAPPIER_CODEX_APP_SERVER_BIN', process.execPath);
      vi.stubEnv('HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON', serializeConnectedServiceChildSelections(new Map([
        ['openai-codex', { kind: 'profile', serviceId: 'openai-codex', profileId: 'primary' }],
      ])) ?? '');
      try {
        const { session } = createLocalSessionHarness();
        await expect(codexLocalLauncher({
          path: root, api: {}, session, messageQueue: createLocalMessageQueue(),
          codexArgs: variant === 'profile' ? ['-p', 'focused', '-c', 'model="fixture"']
            : variant === 'profile-cli-override' ? ['-p', 'focused', '-c', 'sqlite_home="relative-sqlite"']
            : ['-c', 'sqlite_home="relative-sqlite"'],
        })).resolves.toEqual({ type: 'exit', code: 0 });
        const started = JSON.parse(await readFile(join(home, 'tui-start.json'), 'utf8')) as Record<string, unknown>;
        expect(started.baselineInitialized).toBe(true);
        // Native app-server does not consume the TUI's v2 profile selection.
        expect(started.initialized).toBe(variant !== 'profile');
        const bootstrapArgv = JSON.parse(await readFile(join(home, 'bootstrap-argv.json'), 'utf8')) as string[];
        expect(bootstrapArgv).toContain(variant === 'profile' ? 'model="fixture"' : 'sqlite_home="relative-sqlite"');
        expect((await readFile(join(home, 'bootstrap-starts.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
        if (variant !== 'default') {
          expect(started.argv).toEqual(expect.arrayContaining(['-p', 'focused']));
          expect(await readFile(join(home, 'focused.config.toml'), 'utf8')).toBe('sqlite_home = "profile-sqlite"\n');
        }
      } finally {
        vi.unstubAllEnvs();
        await removeTempDir(dirname(executable));
      }
    });
  });
});
