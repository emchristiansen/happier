import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openSqliteDatabaseSync } from './sqliteSync';

describe('read-only SQLite access', () => {
  it('refuses writes to existing databases and never creates missing databases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-sqlite-readonly-'));
    const databasePath = join(root, 'state.sqlite');
    try {
      const writable = openSqliteDatabaseSync(databasePath);
      writable.exec('CREATE TABLE state (value TEXT)');
      writable.exec("INSERT INTO state VALUES ('original')");
      writable.close();
      const before = await readFile(databasePath);
      const readonly = openSqliteDatabaseSync(databasePath, { readOnly: true });
      try {
        expect(readonly.prepare('SELECT value FROM state').get()).toEqual({ value: 'original' });
        expect(() => readonly.exec("INSERT INTO state VALUES ('changed')")).toThrow();
      } finally {
        readonly.close();
      }
      expect(await readFile(databasePath)).toEqual(before);
      const missingPath = join(root, 'missing.sqlite');
      expect(() => openSqliteDatabaseSync(missingPath, { readOnly: true })).toThrow();
      await expect(stat(missingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
