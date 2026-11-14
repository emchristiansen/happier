import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runConnectHoldCommand } from '@/cli/commands/connect/connectHold';

import {
  ConnectedServiceMemberHoldFileUnreadableError,
  createConnectedServiceMemberHoldStore,
  resolveConnectedServiceMemberHoldExclusion,
  type ConnectedServiceMemberHold,
} from './connectedServiceMemberHolds';

const SERVICE = 'claude-subscription';

function hold(profileId: string, lifetime: ConnectedServiceMemberHold['lifetime'], overrides: Partial<ConnectedServiceMemberHold> = {}): ConnectedServiceMemberHold {
  return { serviceId: SERVICE, profileId, reason: 'seven_day limit observed', source: 'placement report r1', heldAtMs: 100, lifetime, ...overrides };
}

async function storeInTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'happier-member-holds-'));
  const filePath = join(dir, 'connected-service-member-holds.json');
  return { filePath, store: createConnectedServiceMemberHoldStore({ filePath }) };
}

describe('connected-service member hold lifetime rule', () => {
  const view = (holds: ConnectedServiceMemberHold[]) => ({
    status: 'readable' as const,
    holdsByProfileId: new Map(holds.map((item) => [item.profileId, item])),
  });

  it('applies an until-hold strictly before its expiry and not at or after it', () => {
    const holds = view([hold('A', { kind: 'until', untilMs: 5_000 })]);
    expect(resolveConnectedServiceMemberHoldExclusion(holds, 'A', 4_999)).toEqual({
      reason: 'held', retryAtMs: 5_000, holdReason: 'seven_day limit observed', holdSource: 'placement report r1',
    });
    expect(resolveConnectedServiceMemberHoldExclusion(holds, 'A', 5_000)).toBeNull();
    expect(resolveConnectedServiceMemberHoldExclusion(holds, 'A', 9_000)).toBeNull();
  });

  it('applies an until-released hold at any time, with no retry time', () => {
    const holds = view([hold('A', { kind: 'until_released' })]);
    expect(resolveConnectedServiceMemberHoldExclusion(holds, 'A', Number.MAX_SAFE_INTEGER)).toMatchObject({ reason: 'held', retryAtMs: null });
    expect(resolveConnectedServiceMemberHoldExclusion(holds, 'B', 0)).toBeNull();
  });

  it('treats unreadable hold state as excluding every member, not as no holds', () => {
    expect(resolveConnectedServiceMemberHoldExclusion({ status: 'unreadable', error: 'bad' }, 'anyone', 0))
      .toEqual({ reason: 'hold_state_unreadable', retryAtMs: null });
  });
});

describe('connected-service member hold store', () => {
  it('reads an absent file as a readable empty set', async () => {
    const { store } = await storeInTempDir();
    const view = await store.readForService(SERVICE);
    expect(view.status).toBe('readable');
    expect(view.status === 'readable' && view.holdsByProfileId.size).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  it('sets, replaces and releases holds per service and profile', async () => {
    const { store } = await storeInTempDir();
    expect(await store.set(hold('A', { kind: 'until_released' }))).toEqual({ previous: null });
    const replaced = hold('A', { kind: 'until', untilMs: 9_000 }, { reason: 'five_hour limit', heldAtMs: 200 });
    expect((await store.set(replaced)).previous).toMatchObject({ lifetime: { kind: 'until_released' } });
    await store.set(hold('A', { kind: 'until_released' }, { serviceId: 'openai-codex' }));

    const claude = await store.readForService(SERVICE);
    expect(claude.status === 'readable' && [...claude.holdsByProfileId.values()]).toEqual([replaced]);
    const codex = await store.readForService('openai-codex');
    expect(codex.status === 'readable' && codex.holdsByProfileId.get('A')?.serviceId).toBe('openai-codex');

    expect(await store.release({ serviceId: SERVICE, profileId: 'A' })).toEqual({ released: replaced });
    expect(await store.release({ serviceId: SERVICE, profileId: 'A' })).toEqual({ released: null });
    const after = await store.readForService(SERVICE);
    expect(after.status === 'readable' && after.holdsByProfileId.size).toBe(0);
    expect(await store.list()).toHaveLength(1);
  });

  it('keeps every concurrent set and release (no lost update)', async () => {
    const { store } = await storeInTempDir();
    const profiles = Array.from({ length: 12 }, (_, index) => `P${index}`);
    await Promise.all(profiles.map((profileId) => store.set(hold(profileId, { kind: 'until_released' }))));
    expect((await store.list()).map((item) => item.profileId).sort()).toEqual([...profiles].sort());
    await Promise.all(profiles.filter((_, index) => index % 2 === 0)
      .map((profileId) => store.release({ serviceId: SERVICE, profileId })));
    expect((await store.list()).map((item) => item.profileId).sort())
      .toEqual(profiles.filter((_, index) => index % 2 === 1).sort());
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['wrong schema', JSON.stringify({ v: 1, holds: [{ serviceId: SERVICE, profileId: 'A' }] })],
    ['duplicate profile', JSON.stringify({ v: 1, holds: [
      hold('A', { kind: 'until_released' }), hold('A', { kind: 'until', untilMs: 1 }),
    ] })],
  ])('reports %s as unreadable and refuses to overwrite it', async (_label, raw) => {
    const { filePath, store } = await storeInTempDir();
    await writeFile(filePath, raw);
    const view = await store.readForService(SERVICE);
    expect(view.status).toBe('unreadable');
    await expect(store.list()).rejects.toBeInstanceOf(ConnectedServiceMemberHoldFileUnreadableError);
    await expect(store.set(hold('B', { kind: 'until_released' }))).rejects.toBeInstanceOf(ConnectedServiceMemberHoldFileUnreadableError);
    await expect(store.release({ serviceId: SERVICE, profileId: 'A' })).rejects.toBeInstanceOf(ConnectedServiceMemberHoldFileUnreadableError);
    expect(await readFile(filePath, 'utf8')).toBe(raw);
  });

  it('validates holds at the boundary', async () => {
    const { store } = await storeInTempDir();
    await expect(store.set(hold('A', { kind: 'until_released' }, { reason: '   ' }))).rejects.toThrow();
    await expect(store.set({ ...hold('A', { kind: 'until_released' }), extra: true } as unknown as ConnectedServiceMemberHold)).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });
});

describe('happier connect hold', () => {
  async function run(args: string[], nowMs = 1_000) {
    const { store, filePath } = await storeInTempDirShared;
    const lines: string[] = [];
    await runConnectHoldCommand({ args, nowMs, store, write: (line) => lines.push(line) });
    return { lines, filePath, store };
  }
  const storeInTempDirShared = storeInTempDir();

  it('sets, lists and releases through the supported command', async () => {
    await run(['set', '--service', SERVICE, '--profile', 'A', '--reason', 'weekly limit', '--source', 'operator', '--until', '1970-01-01T00:00:05.000Z']);
    await run(['set', '--service', SERVICE, '--profile', 'B', '--reason', 'held', '--source', 'operator', '--until-released']);
    const listed = await run(['list', '--json']);
    const parsed = JSON.parse(listed.lines[0]!) as { holds: Array<{ profileId: string; active: boolean; lifetime: unknown }> };
    expect(parsed.holds.map((item) => [item.profileId, item.active, item.lifetime])).toEqual([
      ['A', true, { kind: 'until', untilMs: 5_000 }],
      ['B', true, { kind: 'until_released' }],
    ]);
    expect((await run(['list'], 6_000)).lines[0]).toContain('A: expired');
    await run(['release', '--service', SERVICE, '--profile', 'A']);
    expect((await run(['list', '--json'])).lines[0]).not.toContain('"A"');
  });

  it.each([
    [['set', '--service', SERVICE, '--profile', 'A', '--reason', 'r', '--source', 's'], 'exactly one of --until or --until-released'],
    [['set', '--service', SERVICE, '--profile', 'A', '--reason', 'r', '--source', 's', '--until', '500'], 'not in the future'],
    [['set', '--service', SERVICE, '--profile', 'A', '--reason', 'r', '--until-released'], '--source is required'],
    [['set', '--service', 'not-a-service', '--profile', 'A', '--reason', 'r', '--source', 's', '--until-released'], 'invalid_value'],
  ])('refuses invalid input %j without writing', async (args, message) => {
    const { store } = await storeInTempDir();
    await expect(runConnectHoldCommand({ args, nowMs: 1_000, store, write: () => {} })).rejects.toThrow(message);
    expect(await store.list()).toEqual([]);
  });
});
