import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

import { createTempFixtureSync } from '../../testkit/core/temp_fixture.mjs';
import { assertStackServerProfileReconciled } from './server_profile_reconciliation.mjs';

const serverId = 'stack_dev__id_default';
const internalServerUrl = 'http://127.0.0.1:4311';
const publicServerUrl = 'http://localhost:4311';

function writeCliSettings(fixture, profile) {
  writeFileSync(
    fixture.path('settings.json'),
    JSON.stringify({
      schemaVersion: 6,
      activeServerId: serverId,
      servers: { [serverId]: { id: serverId, name: 'stack', webappUrl: publicServerUrl, ...profile } },
    }) + '\n',
    'utf-8',
  );
}

test('assertStackServerProfileReconciled accepts the CLI shape that omits a local URL equal to the relay URL', (t) => {
  const fixture = createTempFixtureSync(t, { prefix: 'hstack-profile-reconciled-' });
  writeCliSettings(fixture, { serverUrl: internalServerUrl });

  assert.doesNotThrow(() =>
    assertStackServerProfileReconciled({ homeDir: fixture.root, serverId, internalServerUrl, publicServerUrl }),
  );
});

test('assertStackServerProfileReconciled rejects a profile whose split local URL still points elsewhere', (t) => {
  const fixture = createTempFixtureSync(t, { prefix: 'hstack-profile-stale-local-' });
  writeCliSettings(fixture, { serverUrl: internalServerUrl, localServerUrl: 'http://127.0.0.1:3012' });

  assert.throws(
    () => assertStackServerProfileReconciled({ homeDir: fixture.root, serverId, internalServerUrl, publicServerUrl }),
    { code: 'ESTACKCLIPROFILERECONCILIATION', message: /local relay URL was not updated/ },
  );
});
