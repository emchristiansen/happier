import { describe, expect, it } from 'vitest';

import { AGENT_IDS as SHARED_AGENT_IDS } from '@happier-dev/agents';

import { AGENTS_UI } from './registryUi';
import { getAgentPickerIconScale } from './registryUi';

function sortedKeys(value: Record<string, unknown>): string[] {
    return Object.keys(value).sort();
}

describe('agents/registryUi', () => {
    it('covers the full canonical provider universe (no UI-only drift)', () => {
        expect(sortedKeys(AGENTS_UI)).toEqual([...SHARED_AGENT_IDS].sort());
    });

    it('renders Cursor with a provider logo instead of a text glyph fallback', () => {
        const theme = {
            colors: {
                text: {
                    primary: '#111111',
                },
            },
        } as never;

        const xml = AGENTS_UI.cursor.svgIconXml?.(theme);

        expect(xml).toContain('<svg');
        expect(xml).toContain('viewBox="0 0 466.73 532.09"');
    });

    it('renders Devin with the supplied geometry and the active theme color', () => {
        const theme = {
            colors: {
                text: {
                    primary: '#111111',
                },
            },
        } as never;

        const xml = AGENTS_UI.devin.svgIconXml?.(theme);

        expect(xml).toContain('<svg');
        expect(xml).toContain('viewBox="0 0 256 294"');
        expect(xml).toContain('M0,98.5741786');
        expect(xml).toContain('fill="#111111"');
    });

    it('gives every registered agent a themed provider mark', () => {
        // A registered agent without a mark falls back to a generic Ionicon, which reads as an
        // unfinished integration everywhere the backend is offered. Agy shipped that way, and
        // nothing failed, because coverage was only ever asserted one provider at a time.
        const theme = {
            colors: {
                text: {
                    primary: '#111111',
                },
            },
        } as never;

        const withoutMark = [...SHARED_AGENT_IDS].filter((agentId) => {
            const xml = AGENTS_UI[agentId].svgIconXml?.(theme);
            return typeof xml !== 'string' || !xml.includes('<svg');
        });

        expect(withoutMark).toEqual([]);
    });

    it('renders Agy with the project-available Antigravity mark geometry and the active theme color', () => {
        const theme = {
            colors: {
                text: {
                    primary: '#111111',
                },
            },
        } as never;

        const xml = AGENTS_UI.agy.svgIconXml?.(theme);

        expect(xml).toContain('<svg');
        expect(xml).toContain('viewBox="0 0 16 15"');
        expect(xml).toContain('M14.0777 13.984');
        expect(xml).toContain('fill="#111111"');
    });

    it('keeps the Pi picker icon optically scaled for compact picker surfaces', () => {
        expect(getAgentPickerIconScale('pi')).toBe(0.9);
    });

    it('renders Grok with the supplied official mark geometry instead of the fallback glyph', () => {
        const theme = {
            colors: {
                text: {
                    primary: '#111111',
                },
            },
        } as never;

        const xml = AGENTS_UI.grok.svgIconXml?.(theme);

        expect(xml).toContain('<svg');
        expect(xml).toContain('viewBox="0 0 1024 1024"');
        expect(xml).toContain('M395.479 633.828');
        expect(xml).toContain('fill="#111111"');
        expect(AGENTS_UI.grok.cliGlyph).toBe('GX');
        expect(getAgentPickerIconScale('grok')).toBe(1.25);
    });

    it('renders FX with the supplied official glyph geometry and the active theme color', () => {
        const theme = {
            colors: {
                text: {
                    primary: '#111111',
                },
            },
        } as never;

        const xml = AGENTS_UI.fx.svgIconXml?.(theme);

        expect(xml).toContain('<svg');
        expect(xml).toContain('viewBox="0 0 24 24"');
        expect(xml).toContain('M10.5626937,0');
        expect(xml).toContain('fill="#111111"');
    });

    it('renders Droid with the supplied official mark geometry and the active theme color', () => {
        const theme = {
            colors: {
                text: {
                    primary: '#111111',
                },
            },
        } as never;

        const xml = AGENTS_UI.droid.svgIconXml?.(theme);

        expect(xml).toContain('<svg');
        expect(xml).toContain('viewBox="0 0 67 65"');
        expect(xml).toContain('M47.75 11.15a.867.867');
        expect(xml).toContain('fill="#111111"');
    });

    it('slightly enlarges the Claude picker icon to compensate for the logo silhouette', () => {
        expect(getAgentPickerIconScale('claude')).toBe(1.1);
    });

});
