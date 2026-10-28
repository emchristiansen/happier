import type { AgentUiConfig } from '@/agents/registry/registryUi';
import { PROVIDER_LOGO_SVG_XML } from '@/agents/registry/providerLogoSvgXml';

export const AGY_UI: AgentUiConfig = {
    id: 'agy',
    icon: null,
    svgIconXml: PROVIDER_LOGO_SVG_XML.agy ?? null,
    pickerIconScale: 1.1,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.42,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.30),
    },
    cliGlyph: 'AG',
};
