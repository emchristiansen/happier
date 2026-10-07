/**
 * Generates the README "supported agents" logo strip into `.github/`:
 *
 *   .github/supported-agents-light.svg / .png  — dark #57606a glyphs, for LIGHT backgrounds
 *   .github/supported-agents-dark.svg  / .png  — light #8b949e glyphs, for DARK backgrounds
 *
 * Source of truth: `packages/agents/src/manifest.ts` supplies the canonical agent set and
 * order. `apps/ui/sources/agents/registry/providerLogoSvgXml.ts` supplies the exact
 * per-agent monochrome SVG marks rendered by the app. The generator fails if those owners
 * drift, instead of silently omitting a manifest agent or publishing an orphaned mark.
 * Tinting replicates `AgentIcon.applySvgIconColor`:
 * every fill/stroke (except fill="none") becomes the single strip color, so inherently
 * colored marks stay monochrome exactly as in the app.
 *
 * Regenerate with:  yarn generate:agents-strip
 *             (or:  node --experimental-strip-types scripts/generateSupportedAgentsStrip.mjs)
 *
 * PNGs are rasterized at 2x (~2400px wide) for retina README rendering, via the repo's
 * `sharp` dependency. If sharp's native binding is unavailable on this machine (e.g. the
 * workspace was installed for another platform), the SVGs are still written and exact
 * PNG instructions are printed; you can point the script at any working sharp install
 * with SUPPORTED_AGENTS_STRIP_SHARP=/path/to/node_modules/sharp.
 *
 * README.md consumes the PNGs through a <picture> element that switches the light/dark
 * variant on `prefers-color-scheme`. Idempotent: overwrites the four files, nothing else.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');

const LOGO_MODULE_PATH = path.join(
  repoRoot, 'apps', 'ui', 'sources', 'agents', 'registry', 'providerLogoSvgXml.ts',
);
const AGENT_MANIFEST_PATH = path.join(
  repoRoot, 'packages', 'agents', 'src', 'manifest.ts',
);
const OUT_DIR = path.join(repoRoot, '.github');

// Layout (1x units). Mirrors the welcome row's rhythm (square glyph boxes, even gaps):
// 28px glyph boxes inside 44px-tall rows, laid out on TWO centered rows for the README
// (a single 17-glyph line renders each mark too small at README width), rasterized at 2x.
const GLYPH_SIZE = 28;
const GLYPH_GAP = 40;
const PAD_X = 10;
const ROW_HEIGHT = 44;
const ROWS = 2;
const PNG_SCALE = 2;

// Marks excluded from the README strip. `customAcp` is the neutral "bring your own ACP
// CLI" placeholder glyph, not a real agent brand; the welcome screen shows it, the
// README should not (founder decision, 2026-09-21).
const EXCLUDED_AGENT_IDS = new Set(['customAcp']);

const VARIANTS = Object.freeze([
  { name: 'supported-agents-light', color: '#1f2328', note: 'dark glyphs / light background (GitHub light-mode text color)' },
  { name: 'supported-agents-dark', color: '#e6edf3', note: 'light glyphs / dark background (GitHub dark-mode text color)' },
]);

// Same pattern as AgentIcon.applySvgIconColor (agents/registry/AgentIcon.tsx): re-tint
// every fill/stroke attribute except fill="none"; `fill-rule` etc. are untouched because
// the pattern requires `="` right after the attribute name.
const SVG_COLOR_ATTRIBUTE_PATTERN = /\s(fill|stroke)="(?!none\b)[^"]*"/g;

function applySvgIconColor(svgXml, color) {
  return svgXml.replace(SVG_COLOR_ATTRIBUTE_PATTERN, (_match, attribute) => ` ${attribute}="${color}"`);
}

/** Canonical AGENT_IDS order: AGENTS_CORE declaration order in the shared agent manifest. */
async function readManifestAgentOrder() {
  const source = await readFile(AGENT_MANIFEST_PATH, 'utf8');
  const block = source.match(/export const AGENTS_CORE = \{([\s\S]*?)^\}/mu);
  if (!block) {
    throw new Error(`AGENTS_CORE not found in ${AGENT_MANIFEST_PATH}`);
  }
  const keys = [...block[1].matchAll(/^    ([A-Za-z0-9_]+): \{$/gmu)].map((entry) => entry[1]);
  if (keys.length === 0) {
    throw new Error(`No agent ids found in ${AGENT_MANIFEST_PATH}`);
  }
  return keys;
}

function loadSharp() {
  const requireFromRoot = createRequire(path.join(repoRoot, 'package.json'));
  const candidates = [];
  if (process.env.SUPPORTED_AGENTS_STRIP_SHARP) {
    candidates.push(process.env.SUPPORTED_AGENTS_STRIP_SHARP);
  }
  candidates.push('sharp');
  let lastError;
  for (const candidate of candidates) {
    try {
      const loaded = requireFromRoot(candidate);
      return { sharp: loaded, from: candidate };
    } catch (error) {
      lastError = error;
    }
  }
  return { sharp: null, error: lastError };
}

/**
 * Split `count` glyphs into ROWS rows, longer rows first (9 + 8 for 17), each row
 * horizontally centered within the widest row.
 */
function rowLayout(count) {
  const base = Math.floor(count / ROWS);
  const remainder = count % ROWS;
  const rows = Array.from({ length: ROWS }, (_row, i) => base + (i < remainder ? 1 : 0));
  return rows.filter((n) => n > 0);
}

function rowWidth(n) {
  return n * GLYPH_SIZE + (n - 1) * GLYPH_GAP;
}

function buildStripSvg(glyphs, { width, height }) {
  const rows = rowLayout(glyphs.length);
  const maxRowWidth = Math.max(...rows.map(rowWidth));
  const cells = [];
  let cursor = 0;
  rows.forEach((rowCount, rowIndex) => {
    const xStart = PAD_X + (maxRowWidth - rowWidth(rowCount)) / 2;
    const y = rowIndex * ROW_HEIGHT + (ROW_HEIGHT - GLYPH_SIZE) / 2;
    for (let i = 0; i < rowCount; i += 1) {
      const { agentId, xml } = glyphs[cursor];
      cursor += 1;
      const x = xStart + i * (GLYPH_SIZE + GLYPH_GAP);
      // Nest each mark as an inner <svg> so its own viewBox keeps scaling + centering it
      // inside a square box, exactly like AgentIcon's fixed-size SvgXml box.
      const positioned = xml.replace(
        '<svg ',
        `<svg x="${x}" y="${y}" width="${GLYPH_SIZE}" height="${GLYPH_SIZE}" `,
      );
      cells.push(`  <!-- ${agentId} -->\n  ${positioned}`);
    }
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" role="img" aria-label="Supported AI coding agents">`,
    cells.join('\n'),
    '</svg>',
    '',
  ].join('\n');
}

let VIEW_WIDTH = 0;
let VIEW_HEIGHT = 0;

async function main() {
  const logoModule = await import(pathToFileURL(LOGO_MODULE_PATH).href);
  const resolvers = logoModule.PROVIDER_LOGO_SVG_XML;
  if (!resolvers || typeof resolvers !== 'object') {
    throw new Error(`PROVIDER_LOGO_SVG_XML not found in ${LOGO_MODULE_PATH}`);
  }

  const manifestIds = await readManifestAgentOrder();
  const logoIds = Object.keys(resolvers);
  const missingLogoIds = manifestIds.filter(
    (id) => !EXCLUDED_AGENT_IDS.has(id) && typeof resolvers[id] !== 'function',
  );
  const orphanedLogoIds = logoIds.filter((id) => !manifestIds.includes(id));
  if (missingLogoIds.length > 0 || orphanedLogoIds.length > 0) {
    throw new Error([
      'Agent manifest and provider logo map are out of sync.',
      missingLogoIds.length > 0 ? `Missing logos: ${missingLogoIds.join(', ')}` : null,
      orphanedLogoIds.length > 0 ? `Orphaned logos: ${orphanedLogoIds.join(', ')}` : null,
    ].filter(Boolean).join(' '));
  }
  const renderedIds = manifestIds.filter((id) => !EXCLUDED_AGENT_IDS.has(id));
  if (renderedIds.length === 0) throw new Error('No agent logo resolvers found.');

  const rows = rowLayout(renderedIds.length);
  VIEW_WIDTH = PAD_X * 2 + Math.max(...rows.map(rowWidth));
  VIEW_HEIGHT = rows.length * ROW_HEIGHT;

  const { sharp, from: sharpFrom, error: sharpError } = loadSharp();
  const written = [];

  for (const variant of VARIANTS) {
    // The resolvers take the app theme and read `theme.colors.text.primary`; feeding the
    // strip color there plus the AgentIcon re-tint pass reproduces the app pipeline.
    const theme = { colors: { text: { primary: variant.color } } };
    const glyphs = renderedIds.map((agentId) => ({
      agentId,
      xml: applySvgIconColor(resolvers[agentId](theme), variant.color),
    }));

    const svg1x = buildStripSvg(glyphs, { width: VIEW_WIDTH, height: VIEW_HEIGHT });
    const svgPath = path.join(OUT_DIR, `${variant.name}.svg`);
    await writeFile(svgPath, svg1x, 'utf8');
    written.push(`${path.relative(repoRoot, svgPath)} (${VIEW_WIDTH}x${VIEW_HEIGHT})`);

    if (sharp) {
      const svg2x = buildStripSvg(glyphs, {
        width: VIEW_WIDTH * PNG_SCALE,
        height: VIEW_HEIGHT * PNG_SCALE,
      });
      const pngPath = path.join(OUT_DIR, `${variant.name}.png`);
      await sharp(Buffer.from(svg2x)).png().toFile(pngPath);
      written.push(`${path.relative(repoRoot, pngPath)} (${VIEW_WIDTH * PNG_SCALE}x${VIEW_HEIGHT * PNG_SCALE})`);
    }
  }

  console.log(`Rendered ${renderedIds.length} agent marks (shared manifest AGENT_IDS order):`);
  console.log(`  ${renderedIds.join(', ')}`);
  console.log('Wrote:');
  for (const file of written) console.log(`  ${file}`);
  if (sharp) {
    console.log(`PNG rasterizer: sharp (resolved via ${sharpFrom === 'sharp' ? 'workspace root node_modules' : sharpFrom})`);
  } else {
    console.warn('\nWARNING: sharp could not be loaded on this machine — SVGs written, PNGs skipped.');
    if (sharpError) console.warn(`  (${String(sharpError.message).split('\n')[0]})`);
    console.warn('  To produce the PNGs, either:');
    console.warn('    - re-run inside the dev VM / any machine where the workspace sharp install matches the platform, or');
    console.warn('    - SUPPORTED_AGENTS_STRIP_SHARP=/path/to/node_modules/sharp yarn generate:agents-strip, or');
    console.warn(`    - rsvg-convert -w ${VIEW_WIDTH * PNG_SCALE} .github/supported-agents-light.svg -o .github/supported-agents-light.png (and the dark variant).`);
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
