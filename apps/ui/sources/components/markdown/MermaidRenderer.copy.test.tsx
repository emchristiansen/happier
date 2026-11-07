import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createOnShouldStartLoadWithRequest } from 'react-native-webview/lib/WebViewShared.js';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const clipboardMocks = vi.hoisted(() => ({
  setStringAsync: vi.fn(async () => true),
}));
const modalMocks = vi.hoisted(() => ({
  alert: vi.fn(),
}));
const linkingMocks = vi.hoisted(() => ({
  canOpenURL: vi.fn(async () => true),
  openURL: vi.fn(async () => {}),
}));
vi.mock('expo-clipboard', () => clipboardMocks);
vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});
vi.mock('@/components/ui/text/Text', async () => {
  const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
  return createUiTextModuleMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

installMarkdownCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: modalMocks,
        }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
            Linking: linkingMocks,
        });
    },
});

vi.mock('./mermaidWebViewBundle.generated', () => ({
  MERMAID_WEBVIEW_BUNDLE_JS: [
    'globalThis.HAPPIER_MERMAID = {};',
    'globalThis.HAPPIER_MERMAID_REMOVE_NAVIGATION = () => {};',
  ].join('\n'),
}));

let lastWebViewHtml: string | null = null;
let lastWebViewProps: Record<string, unknown> | null = null;
vi.mock('react-native-webview', () => ({
  WebView: (props: any) => {
    lastWebViewHtml = props?.source?.html ?? null;
    lastWebViewProps = props;
    return null;
  },
}));

describe('MermaidRenderer', () => {
  it('copies raw Mermaid source to clipboard', async () => {
    const { MermaidRenderer } = await import('./MermaidRenderer');

    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      screen = await renderScreen(<MermaidRenderer content={'graph TD\\nA-->B'} />);

      expect(screen.findByTestId('mermaid-copy-button')).not.toBeNull();

      clipboardMocks.setStringAsync.mockClear();
      modalMocks.alert.mockClear();
      await screen.pressByTestIdAsync('mermaid-copy-button');

      expect(clipboardMocks.setStringAsync).toHaveBeenCalledWith('graph TD\\nA-->B');
      expect(modalMocks.alert).not.toHaveBeenCalledWith('common.success', 'markdown.codeCopied', expect.anything());
      expect(screen.findByTestId('mermaid-copy-feedback')).not.toBeNull();
    } finally {
      await screen?.unmount();
    }
  });

  it('does not interpolate Mermaid source into native WebView HTML', async () => {
    const { MermaidRenderer } = await import('./MermaidRenderer');

    lastWebViewHtml = null;
    const payload = 'graph TD\\nA-->B\\n%% </div><img src=x onerror=alert(1)>\\n';

    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      screen = await renderScreen(<MermaidRenderer content={payload} />);

      expect(typeof lastWebViewHtml).toBe('string');
      expect(lastWebViewHtml).toContain('<div id=\"mermaid-container\"></div>');
      // The source must not be placed as raw HTML content inside the container.
      expect(lastWebViewHtml).not.toContain(`<div id=\"mermaid-container\" class=\"mermaid\">`);
      expect(lastWebViewHtml).not.toContain(payload);
    } finally {
      await screen?.unmount();
    }
  });

  it('renders native Mermaid from the bundled runtime with network and navigation denied', async () => {
    const { MermaidRenderer } = await import('./MermaidRenderer');

    lastWebViewHtml = null;
    lastWebViewProps = null;
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      screen = await renderScreen(<MermaidRenderer content={'graph TD\\nA-->B'} />);

      expect(lastWebViewHtml).toContain('HAPPIER_MERMAID');
      expect(lastWebViewHtml).toContain('HAPPIER_MERMAID_REMOVE_NAVIGATION');
      expect(lastWebViewHtml).not.toMatch(/https?:\/\//);
      expect(lastWebViewHtml).toContain("default-src 'none'");
      expect(lastWebViewProps).toMatchObject({
        originWhitelist: ['*'],
        javaScriptCanOpenWindowsAutomatically: false,
        setSupportMultipleWindows: false,
        mixedContentMode: 'never',
        allowFileAccess: false,
        allowUniversalAccessFromFileURLs: false,
      });
      expect((lastWebViewProps as any)?.onShouldStartLoadWithRequest?.({ url: 'https://tracker.example/pixel' })).toBe(false);
      expect((lastWebViewProps as any)?.onShouldStartLoadWithRequest?.({ url: 'about:blank' })).toBe(true);
    } finally {
      await screen?.unmount();
    }
  });

  it('routes every native navigation through the deny policy without invoking OS Linking', async () => {
    const { MermaidRenderer } = await import('./MermaidRenderer');

    linkingMocks.canOpenURL.mockClear();
    linkingMocks.openURL.mockClear();
    lastWebViewProps = null;

    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      screen = await renderScreen(<MermaidRenderer content={'graph TD\\nA-->B'} />);
      const onShouldStartLoadWithRequest = (lastWebViewProps as any)?.onShouldStartLoadWithRequest;
      const originWhitelist = (lastWebViewProps as any)?.originWhitelist;
      const loadRequest = vi.fn();
      const wrapperHandler = createOnShouldStartLoadWithRequest(
        loadRequest,
        originWhitelist,
        onShouldStartLoadWithRequest,
      );

      for (const [index, url] of [
        'https://attacker.example/path',
        'happier-test://open',
        '/relative-target',
        'about:blank',
      ].entries()) {
        wrapperHandler({
          nativeEvent: {
            url,
            lockIdentifier: index + 1,
          },
        } as never);
      }
      await Promise.resolve();
      await Promise.resolve();

      expect(loadRequest.mock.calls.map(([allowed, url]) => [allowed, url])).toEqual([
        [false, 'https://attacker.example/path'],
        [false, 'happier-test://open'],
        [false, '/relative-target'],
        [true, 'about:blank'],
      ]);
      expect(linkingMocks.canOpenURL).not.toHaveBeenCalled();
      expect(linkingMocks.openURL).not.toHaveBeenCalled();
    } finally {
      await screen?.unmount();
    }
  });

  it('ignores malformed or oversized native WebView messages', async () => {
    const { MermaidRenderer } = await import('./MermaidRenderer');
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
      screen = await renderScreen(<MermaidRenderer content={'graph TD\\nA-->B'} />);
      const onMessage = (lastWebViewProps as any)?.onMessage;

      expect(() => onMessage?.({ nativeEvent: { data: '{not-json' } })).not.toThrow();
      expect(() => onMessage?.({ nativeEvent: { data: JSON.stringify({ type: 'dimensions', height: 'huge' }) } })).not.toThrow();
      expect(() => onMessage?.({ nativeEvent: { data: 'x'.repeat(10_000) } })).not.toThrow();
    } finally {
      await screen?.unmount();
    }
  });
});
