import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { Platform } from 'react-native';

/**
 * One size for the session header's icon actions.
 *
 * This file used to carry three tiers — a base size plus two hand-measured optical corrections for
 * glyphs that painted more ink than their neighbours at the same number. Those corrections existed
 * because the header mixed Ionicons and Octicons: two families drawn to different grids, so matching
 * the numbers did not match the ink.
 *
 * Behind a single-family seam that problem leaves this file entirely. The header asks for one size,
 * and any glyph that still diverges optically is corrected once, per glyph, inside `Icon` — the only
 * place that can reasonably know about a glyph's ink.
 */
export const SESSION_HEADER_ICON_SIZE_PX = ICON_SIZE.md;

/** Native touch boxes follow the stricter platform minimum; pointer and iOS layouts remain 44pt. */
export function resolveSessionHeaderActionTargetPx(platformOS: typeof Platform.OS = Platform.OS): number {
    return platformOS === 'android' ? 48 : 44;
}
