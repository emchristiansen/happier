import type { AgentUiConfig } from '@/agents/registry/registryUi';
import { PROVIDER_LOGO_SVG_XML } from '@/agents/registry/providerLogoSvgXml';

export const DROID_UI: AgentUiConfig = {
    id: 'droid',
    icon: null,
    svgIconXml: PROVIDER_LOGO_SVG_XML.droid ?? null,
    tintColor: null,
    avatarOverlay: { circleScale: 0.42, iconScale: ({ size }) => Math.round(size * 0.3) },
    cliGlyph: 'FD',
};
