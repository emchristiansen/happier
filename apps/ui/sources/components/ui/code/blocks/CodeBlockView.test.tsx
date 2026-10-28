import React from 'react';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { CodeBlockView } from './CodeBlockView';

function isTextSurface(node: ReactTestInstance): boolean {
    for (let parent = node.parent; parent; parent = parent.parent) {
        const hostType: unknown = parent.type;
        if (hostType === 'Text') return false;
    }
    return true;
}

const originalPlatform = Platform.OS;
afterEach(() => {
    standardCleanup();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
    vi.restoreAllMocks();
});

describe('CodeBlockView (native)', () => {
    it.each(['ios', 'android'] as const)('preserves large multiline code and copy with platform-appropriate selection on %s', async (platform) => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: platform });
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        // Mirrors the reproduced Debug shape: many lines plus a very wide serialized message.
        const lines = ['{', ...Array.from({ length: 5_985 }, (_, i) => `  "message${i}": "${i === 100 ? 'x'.repeat(17_214) : 'content'}",`), '}', ''];
        const code = lines.join('\n');
        const copy = vi.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
        const screen = await renderScreen(<CodeBlockView code={code} showCopyButton scrollTestID="debug-code" />);
        const scroll = screen.findByTestId('debug-code')!;
        const texts = scroll.findAllByType('Text').filter(isTextSurface);

        expect(texts).toHaveLength(lines.length);
        expect(texts.map(node => node.props.children).join('\n')).toBe(code);
        expect(texts.every(node => node.props.selectable === (platform !== 'android'))).toBe(true);
        await act(async () => { await screen.findByProps({ accessibilityLabel: 'Copy' }).props.onPress(); });
        expect(copy).toHaveBeenCalledWith(code);
    });

    it('preserves blank lines and tokens when syntax highlighting is enabled', async () => {
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'simple' });
        const lines = ['const x = 1;', '', '// comment', ''];
        const screen = await renderScreen(<CodeBlockView code={lines.join('\r\n')} language="typescript" scrollTestID="highlighted-code" />);
        const scroll = screen.findByTestId('highlighted-code')!;
        const outerTexts = scroll.findAllByType('Text').filter(isTextSurface);
        expect(outerTexts).toHaveLength(lines.length);
        expect(outerTexts[0]!.findAllByType('Text').some(node => node.props.children === 'const')).toBe(true);
        expect(outerTexts.map(node => node.findAllByType('Text').filter(text => typeof text.props.children === 'string').map(text => text.props.children).join(''))).toEqual(lines);
    });
});
