import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const localControlDir = dirname(fileURLToPath(import.meta.url));
const cliSourceRoot = resolve(localControlDir, '..', '..');

const guardedFiles = [
  'agent/localControl/createAgentLocalControlState.ts',
  'agent/localControl/createLocalRemoteModeController.ts',
] as const;

describe('local-control topology writeability policy', () => {
  it('does not use shared topology as a writeability or terminal-injection signal', async () => {
    const violations: string[] = [];

    for (const relativePath of guardedFiles) {
      const source = await readFile(resolve(cliSourceRoot, relativePath), 'utf8');
      const disallowedPatterns = [
        /remoteWritable\s*:[^\n]*(?:topology|capability\.topology)\s*={2,3}\s*['"]shared['"]/,
        /(?:topology|capability\.topology)\s*={2,3}\s*['"]shared['"][^\n]*remoteWritable/,
        /(?:topology|capability\.topology)\s*={2,3}\s*['"]shared['"][\s\S]{0,160}inject/i,
      ];

      for (const pattern of disallowedPatterns) {
        if (pattern.test(source)) violations.push(`${relativePath}: ${pattern.source}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
