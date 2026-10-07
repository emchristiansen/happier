import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { TransportHandler } from '@/agent/transport';
import { createProbeTempDir, writeExecutableScript } from './agentModelsProbe.testkit';
import { probeAcpAgentCapabilities } from './acpProbe';

describe('probeAcpAgentCapabilities (cache)', () => {
  it('caches results and avoids respawning the probe within TTL', async () => {
    const fixture = await createProbeTempDir('happier-acp-probe-cache');

    const countFile = resolve(join(fixture.dir, 'count.txt'));
    await writeFile(countFile, '', 'utf8');

    const agentPath = resolve(join(fixture.dir, 'fake-agent.mjs'));
    await writeExecutableScript(
      agentPath,
      `#!${process.execPath}
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const countFile = process.env.HAPPIER_TEST_ACP_PROBE_COUNT_FILE;
if (countFile) appendFileSync(countFile, "1");

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
    protocolVersion: 1, agentCapabilities: { loadSession: process.env.HAPPIER_TEST_ACP_LOAD === 'yes' }
  } }) + '\\n');
});
`,
    );

    const transport = { agentName: 'fake' } as TransportHandler;
    const base: Parameters<typeof probeAcpAgentCapabilities>[0] = {
      command: process.platform === 'win32' ? process.execPath : agentPath,
      args: process.platform === 'win32' ? [agentPath] : [],
      cwd: fixture.dir,
      env: { HAPPIER_TEST_ACP_PROBE_COUNT_FILE: countFile },
      transport,
      timeoutMs: 2_000,
    };

    expect(await probeAcpAgentCapabilities(base)).toMatchObject({ ok: true, agentCapabilities: { loadSession: false } });
    const afterFirst = (await readFile(countFile, 'utf8')).length;

    await probeAcpAgentCapabilities(base);
    const afterSecond = (await readFile(countFile, 'utf8')).length;

    expect(afterSecond).toBe(afterFirst);
    expect(afterFirst).toBe(1);
    const changed = await probeAcpAgentCapabilities({
      ...base,
      env: { ...base.env, HAPPIER_TEST_ACP_LOAD: 'yes' },
    });
    expect(changed).toMatchObject({ ok: true, agentCapabilities: { loadSession: true } });
    expect((await readFile(countFile, 'utf8')).length).toBe(2);
    if (process.platform !== 'win32') {
      const source = await readFile(agentPath, 'utf8');
      await writeFile(agentPath, source.replace("process.env.HAPPIER_TEST_ACP_LOAD === 'yes'", 'false'));
      const replaced = await probeAcpAgentCapabilities({
        ...base, env: { ...base.env, HAPPIER_TEST_ACP_LOAD: 'yes' },
      });
      expect(replaced).toMatchObject({ ok: true, agentCapabilities: { loadSession: false } });
      expect((await readFile(countFile, 'utf8')).length).toBe(3);
    }
    await fixture.cleanup();
  }, 20_000);
});
