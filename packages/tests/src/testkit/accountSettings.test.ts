import { afterEach, describe, expect, it, vi } from 'vitest';

import { patchPlainAccountSettingsV2 } from './accountSettings';

describe('patchPlainAccountSettingsV2', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges a patch over the authoritative server settings in one CAS update', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: {
          t: 'plain',
          v: {
            sessionListActiveGroupingV1: 'date',
            sessionListInactiveGroupingV1: 'date',
            unrelatedSetting: true,
          },
        },
        version: 7,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, version: 8 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await patchPlainAccountSettingsV2({
      baseUrl: 'http://server.test',
      token: 'token',
      settingsPatch: {
        sessionListActiveGroupingV1: 'project',
        sessionListInactiveGroupingV1: 'project',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, updateInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(updateInit.body))).toEqual({
      expectedVersion: 7,
      content: {
        t: 'plain',
        v: {
          sessionListActiveGroupingV1: 'project',
          sessionListInactiveGroupingV1: 'project',
          unrelatedSetting: true,
        },
      },
    });
  });

  it('reapplies the patch over the authoritative snapshot returned by an optimistic concurrency conflict', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: { t: 'plain', v: { existing: 'first' } },
        version: 7,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        error: 'version-mismatch',
        currentVersion: 8,
        currentContent: { t: 'plain', v: { existing: 'concurrent', addedByBrowser: true } },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, version: 9 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(patchPlainAccountSettingsV2({
      baseUrl: 'http://server.test',
      token: 'token',
      settingsPatch: { requestedByTest: true },
    })).resolves.toBe(9);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, retryUpdateInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(String(retryUpdateInit?.body))).toEqual({
      expectedVersion: 8,
      content: {
        t: 'plain',
        v: {
          existing: 'concurrent',
          addedByBrowser: true,
          requestedByTest: true,
        },
      },
    });
  });
});
