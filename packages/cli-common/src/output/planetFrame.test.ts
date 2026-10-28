import { describe, expect, it } from 'vitest';

import { PLANET_BREATH_SECONDS, createPlanetFrame, planetRowsForColumns, type PlanetFrame } from '../../planetFrame.mjs';

const BRAILLE_DOTS = [[1, 8], [2, 16], [4, 32], [64, 128]] as const;

function litDots(frame: PlanetFrame): Array<{ x: number; y: number }> {
  const dots: Array<{ x: number; y: number }> = [];
  frame.forEach((row, rowIndex) => row.forEach((cell, column) => {
    if (!cell) return;
    const bits = cell.ch.codePointAt(0)! - 0x2800;
    BRAILLE_DOTS.forEach((pair, dy) => pair.forEach((bit, dx) => {
      if (bits & bit) dots.push({ x: column * 2 + dx, y: rowIndex * 4 + dy });
    }));
  }));
  return dots;
}

const luminance = (rgb: readonly number[]) => 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
const meanLuminance = (frame: PlanetFrame) => {
  const cells = frame.flat().filter((cell) => cell !== null);
  return cells.reduce((sum, cell) => sum + luminance(cell.rgb), 0) / cells.length;
};
const glyphs = (frame: PlanetFrame) => frame.map((row) => row.map((cell) => cell?.ch ?? ' ').join(''));
const changedGlyphs = (a: PlanetFrame, b: PlanetFrame) =>
  a.flat().filter((cell, index) => (cell?.ch ?? ' ') !== (b.flat()[index]?.ch ?? ' ')).length;
const largestColourStep = (a: PlanetFrame, b: PlanetFrame) => Math.max(0, ...a.flat().map((cell, index) => {
  const other = b.flat()[index];
  return cell && other && cell.ch === other.ch ? Math.max(...cell.rgb.map((value, channel) => Math.abs(value - other.rgb[channel]!))) : 0;
}));

describe('planet frame', () => {
  it('fills a fixed terminal canvas with coloured Braille cells only', () => {
    const frame = createPlanetFrame({ columns: 24, seconds: 8 });
    expect(frame).toHaveLength(planetRowsForColumns(24));
    expect(planetRowsForColumns(24)).toBe(11);
    for (const row of frame) {
      expect(row).toHaveLength(24);
      for (const cell of row) {
        if (!cell) continue;
        const code = cell.ch.codePointAt(0)!;
        expect(code).toBeGreaterThan(0x2800);
        expect(code).toBeLessThanOrEqual(0x28ff);
        expect(cell.rgb).toHaveLength(3);
      }
    }
  });

  it('draws a round globe once terminal cell proportions are applied', () => {
    // The eclipse crescent traces the limb. A Braille dot is half a cell wide and a
    // quarter of a 2.2:1 cell tall; measured in those units the limb is a circle.
    const columns = 28;
    const rows = planetRowsForColumns(columns);
    const limb = new Map<number, number>();
    for (const dot of litDots(createPlanetFrame({ columns, seconds: 0.25 }))) {
      const x = (dot.x + 0.5) * 0.5 - columns / 2;
      const y = (dot.y + 0.5) * 0.55 - (rows * 2.2) / 2;
      const sector = Math.round(Math.atan2(y, x) / (Math.PI / 9));
      limb.set(sector, Math.max(limb.get(sector) ?? 0, Math.hypot(x, y)));
    }
    const radii = [...limb.values()].sort((a, b) => a - b);
    expect(radii.length).toBeGreaterThanOrEqual(6);
    expect((radii.at(-1)! - radii[0]!) / radii[Math.floor(radii.length / 2)]!).toBeLessThan(0.06);
  });

  it('opens as an eclipse: a thin lit crescent on the right grows into the full face', () => {
    const early = litDots(createPlanetFrame({ columns: 28, seconds: 0.25 }));
    const settled = litDots(createPlanetFrame({ columns: 28, seconds: 8 }));
    expect(early.length).toBeLessThan(settled.length * 0.45);
    const middle = 28;
    expect(early.filter((dot) => dot.x >= middle).length).toBeGreaterThan(early.filter((dot) => dot.x < middle).length * 2);
    // Without the intro (setup continuing an installer welcome) the face is already lit.
    const continued = litDots(createPlanetFrame({ columns: 28, seconds: 0.25, intro: false }));
    expect(continued.length).toBeGreaterThan(settled.length * 0.8);
  });

  it('comes to rest, then only breathes: slowly, calmly and forever', () => {
    expect(PLANET_BREATH_SECONDS).toBeGreaterThanOrEqual(8);
    const rest = createPlanetFrame({ columns: 28, seconds: 12 });
    const oneBreathLater = createPlanetFrame({ columns: 28, seconds: 12 + PLANET_BREATH_SECONDS });
    // The spin has settled, so one full breath later the picture is the same.
    expect(glyphs(oneBreathLater)).toEqual(glyphs(rest));
    expect(largestColourStep(rest, oneBreathLater)).toBeLessThanOrEqual(1);
    // Still alive: inhale and exhale differ visibly...
    const exhaled = createPlanetFrame({ columns: 28, seconds: 12 * PLANET_BREATH_SECONDS });
    const inhaled = createPlanetFrame({ columns: 28, seconds: 12 * PLANET_BREATH_SECONDS + PLANET_BREATH_SECONDS / 2 });
    expect(changedGlyphs(exhaled, inhaled)).toBeGreaterThan(0);
    expect(litDots(inhaled).length).toBeGreaterThan(litDots(exhaled).length);
    // ...but a tenth of a second never jolts the picture.
    const cells = exhaled.flat().filter(Boolean).length;
    for (let t = 12; t < 12 + PLANET_BREATH_SECONDS; t += 0.5) {
      const now = createPlanetFrame({ columns: 28, seconds: t });
      const next = createPlanetFrame({ columns: 28, seconds: t + 0.1 });
      expect(changedGlyphs(now, next)).toBeLessThan(cells * 0.2);
      expect(largestColourStep(now, next)).toBeLessThanOrEqual(26);
    }
  });

  it('dims in place without changing the silhouette', () => {
    const bright = createPlanetFrame({ columns: 24, seconds: 8 });
    const dimmed = createPlanetFrame({ columns: 24, seconds: 8, dim: 1 });
    expect(glyphs(dimmed)).toEqual(glyphs(bright));
    expect(meanLuminance(dimmed)).toBeLessThan(meanLuminance(bright) * 0.6);
  });

  it('uses the light planet palette on light terminals', () => {
    const dark = createPlanetFrame({ columns: 24, seconds: 8, theme: 'dark' });
    const light = createPlanetFrame({ columns: 24, seconds: 8, theme: 'light' });
    expect(meanLuminance(light)).toBeGreaterThan(meanLuminance(dark));
  });
});
