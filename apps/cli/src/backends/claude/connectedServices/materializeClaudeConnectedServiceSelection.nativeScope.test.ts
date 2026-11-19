import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { materializeClaudeConnectedServiceSelection } from './materializeClaudeConnectedServiceSelection';

it.each([false, true])('validates the imported native configuration (excluded=%s)', async (excluded) => {
  const root = await mkdtemp(join(tmpdir(), 'native-scope-'));
  try {
    const activeServerDir = join(root, 'server');
    const otherHome = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'claude-subscription', 'other');
    const ambient = join(root, 'benign');
    const native = join(root, 'native');
    for (const p of [otherHome, ambient, native]) await mkdir(p, { recursive: true });
    await writeFile(join(ambient, 'settings.json'), JSON.stringify({ model: 'ambient' }));
    await writeFile(join(otherHome, 'settings.json'), JSON.stringify({ model: 'excluded' }));
    if (excluded) await symlink(join(otherHome, 'settings.json'), join(native, 'settings.json'));
    else await writeFile(join(native, 'settings.json'), JSON.stringify({ model: 'permitted-native' }));
    const record = buildConnectedServiceCredentialRecord({ now: Date.now(), serviceId: 'anthropic', profileId: 'work', kind: 'token', token: { token: 'synthetic-key', providerAccountId: 'synthetic-account', providerEmail: 'test@example.test' } });
    const result = await materializeClaudeConnectedServiceSelection({
      activeServerDir, serviceId: 'anthropic', record, fallbackProfileId: 'work',
      processEnv: { HOME: root, CLAUDE_CONFIG_DIR: ambient, HAPPIER_CLAUDE_NATIVE_CONFIG_DIR: native },
    });
    if (!result) throw new Error('unexpected null materialization');
    if (excluded) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'claude_configuration_source_outside_permitted_scope', reason: 'resolves_to_managed_home' }));
      await expect(readFile(join(result.targetMaterializedRoot, 'settings.json'), 'utf8')).rejects.toThrow();
    } else {
      expect(result.diagnostics).toEqual([]);
      expect(JSON.parse(await readFile(join(result.targetMaterializedRoot, 'settings.json'), 'utf8'))).toMatchObject({ model: 'permitted-native' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
