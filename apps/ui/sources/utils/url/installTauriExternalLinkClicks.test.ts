// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const openExternalUrl = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./openExternalUrl', () => ({ openExternalUrl }));

import { installTauriExternalLinkClicks } from './installTauriExternalLinkClicks';

afterEach(() => {
  document.body.replaceChildren();
  openExternalUrl.mockClear();
});

describe('installTauriExternalLinkClicks', () => {
  it('routes React Native web Linking window opens through the desktop opener', () => {
    const originalOpen = window.open;
    const webviewOpen = vi.fn(() => null);
    window.open = webviewOpen;
    const remove = installTauriExternalLinkClicks();
    try {
      window.open('https://example.com/page', '_blank', 'noopener');
      expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/page');
      expect(webviewOpen).not.toHaveBeenCalled();
    } finally {
      remove();
      window.open = originalOpen;
    }
  });

  it('opens a blank-target link in the system browser without navigating the webview', () => {
    const remove = installTauriExternalLinkClicks();
    const link = document.createElement('a');
    link.href = 'https://example.com/page';
    link.target = '_blank';
    link.textContent = 'Example';
    document.body.append(link);

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/page');
    remove();
  });
});
