import type { AgentUiConfig } from '@/agents/registry/registryUi';
import { PROVIDER_LOGO_SVG_XML } from '@/agents/registry/providerLogoSvgXml';

export const DEVIN_UI: AgentUiConfig = {
    id: 'devin',
    icon: null,
    svgIconXml: PROVIDER_LOGO_SVG_XML.devin ?? null,
    pickerIconScale: 1.1,
    tintColor: null,
    avatarOverlay: {
        circleScale: 0.42,
        iconScale: ({ size }: { size: number }) => Math.round(size * 0.30),
    },
    cliGlyph: 'DV',
};
