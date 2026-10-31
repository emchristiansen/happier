import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

describe('getClipboardStringTrimmedSafe', () => {
    it('returns trimmed clipboard contents', async () => {
        vi.resetModules();
        vi.doMock('expo-clipboard', () => {
            return {
                getStringAsync: vi.fn(async () => '  hello  '),
            };
        });

        const { getClipboardStringTrimmedSafe } = await import('./clipboard');
        await expect(getClipboardStringTrimmedSafe()).resolves.toBe('hello');
    });

    it('returns empty string when clipboard read throws', async () => {
        vi.resetModules();
        vi.doMock('expo-clipboard', () => {
            return {
                getStringAsync: vi.fn(async () => {
                    throw new Error('clipboard failed');
                }),
            };
        });

        const { getClipboardStringTrimmedSafe } = await import('./clipboard');
        await expect(getClipboardStringTrimmedSafe()).resolves.toBe('');
    });

    it('returns empty string when clipboard contents are whitespace only', async () => {
        vi.resetModules();
        vi.doMock('expo-clipboard', () => {
            return {
                getStringAsync: vi.fn(async () => ' \n\t '),
            };
        });

        const { getClipboardStringTrimmedSafe } = await import('./clipboard');
        await expect(getClipboardStringTrimmedSafe()).resolves.toBe('');
    });
});

describe('setClipboardStringSafe', () => {
    it('writes to clipboard and returns true', async () => {
        vi.resetModules();
        const setStringAsync = vi.fn(async () => true);
        vi.doMock('expo-clipboard', () => {
            return {
                setStringAsync,
            };
        });

        const { setClipboardStringSafe } = await import('./clipboard');
        await expect(setClipboardStringSafe('hello')).resolves.toBe(true);
        expect(setStringAsync).toHaveBeenCalledWith('hello');
    });

    it('returns false when clipboard write throws', async () => {
        vi.resetModules();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.doMock('expo-clipboard', () => {
            return {
                setStringAsync: vi.fn(async () => {
                    throw new Error('clipboard failed');
                }),
            };
        });

        const { setClipboardStringSafe } = await import('./clipboard');
        await expect(setClipboardStringSafe('hello')).resolves.toBe(false);
        expect(warning).toHaveBeenCalledWith(expect.stringMatching(/clipboard/i));
    });

    it('returns false when the platform refuses the clipboard write', async () => {
        vi.resetModules();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.doMock('expo-clipboard', () => ({
            setStringAsync: vi.fn(async () => false),
        }));

        const { setClipboardStringSafe } = await import('./clipboard');
        await expect(setClipboardStringSafe('hello')).resolves.toBe(false);
        expect(warning).toHaveBeenCalledWith(expect.stringMatching(/clipboard/i));
    });
});
