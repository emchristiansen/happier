// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { sanitizeEnrichedMarkdownLinkTargets } from './enrichedMarkdownLinkHandling';
import { preprocessStreamingMarkdown } from '../streaming/preprocessStreamingMarkdown';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const REVEAL_SELECTOR = '[data-happier-enriched-markdown-reveal="text"]';
const LINK_LABEL = 'zlink-006';
type WebEnrichedMarkdownTextModule = Readonly<{
    EnrichedMarkdownText: React.ComponentType<{
        markdown: string;
        streamingAnimation?: boolean;
    }>;
}>;

type WebParseMarkdownModule = Readonly<{
    preloadMarkdownRuntime: () => Promise<void>;
}>;

// Literal imports let Vitest resolve and transform the real patched package under jsdom.
async function loadPatchedWebEnrichedMarkdownText(): Promise<WebEnrichedMarkdownTextModule> {
    return import('../../../../node_modules/react-native-enriched-markdown/src/web/EnrichedMarkdownText.tsx');
}

async function loadPatchedWebParseMarkdown(): Promise<WebParseMarkdownModule> {
    return import('../../../../node_modules/react-native-enriched-markdown/src/web/parseMarkdown.ts');
}

/**
 * The exact transform chain a streaming transcript run renders through:
 * `MarkdownViewRenderer` repairs the streamed source, then
 * `EnrichedMarkdownTextAdapter` sanitizes link targets before the package parses it.
 */
function renderedMarkdownFor(streamedChunk: string): string {
    return sanitizeEnrichedMarkdownLinkTargets(preprocessStreamingMarkdown(streamedChunk));
}

function collectRevealSpanInserts(records: readonly MutationRecord[], into: string[]): void {
    for (const record of records) {
        record.addedNodes.forEach((node) => {
            if (!(node instanceof HTMLElement)) return;
            if (node.matches(REVEAL_SELECTOR)) into.push(node.textContent ?? '');
            node.querySelectorAll(REVEAL_SELECTOR).forEach((element) => {
                into.push(element.textContent ?? '');
            });
        });
    }
}

describe('EnrichedMarkdownText — inline link completion (live flicker 2026-08-03)', () => {
    it('inserts the reveal span for a link label exactly once across the link completing', async () => {
        // MEASURED on real Codex streams: 12/12 inline link labels were inserted as a
        // reveal span twice — legible plain text, one blank painted frame, then a re-fade
        // from opacity 0 as a link. 0/38 bold tokens ever did, because `**` is closed
        // eagerly by the streaming repair while a link's URL is unknowable until `)`.
        // This test counts the same thing the live DOM instrument counted: how many times
        // a reveal span carrying the label enters the document.
        const parser = await loadPatchedWebParseMarkdown();
        await parser.preloadMarkdownRuntime();
        const { EnrichedMarkdownText } = await loadPatchedWebEnrichedMarkdownText();
        const globalWithReact = globalThis as typeof globalThis & { React?: typeof React };
        globalWithReact.React = React;

        const container = document.createElement('div');
        document.body.appendChild(container);
        const inserts: string[] = [];
        const observer = new MutationObserver((records) => collectRevealSpanInserts(records, inserts));
        observer.observe(container, { childList: true, subtree: true });
        const root = createRoot(container);

        const paintChunk = async (streamedChunk: string) => {
            await act(async () => {
                root.render(
                    <EnrichedMarkdownText markdown={renderedMarkdownFor(streamedChunk)} streamingAnimation />,
                );
            });
            // Records already delivered to the callback are drained from the queue; this
            // picks up anything still pending when the render settled.
            collectRevealSpanInserts(observer.takeRecords(), inserts);
        };

        const settled = 'Streamed intro already on screen.';
        await paintChunk(settled);
        await paintChunk(`${settled} See [${LINK_LABEL}](https://exa`);

        const insertsAfterLabelArrived = inserts.filter((text) => text === LINK_LABEL).length;
        // The label must animate in when it arrives. Suppressing or delaying the reveal
        // until the URL completes would hide the defect instead of removing it.
        expect(insertsAfterLabelArrived).toBe(1);

        await paintChunk(`${settled} See [${LINK_LABEL}](https://example.com/docs) and more.`);

        expect(inserts.filter((text) => text === LINK_LABEL).length).toBe(1);
        expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/docs');

        await act(async () => {
            root.unmount();
        });
        observer.disconnect();
        container.remove();
    });
});
