/**
 * Dependency-free Happier planet owner, shared by terminal renderers and generated
 * installer projections.
 *
 * The planet is a lit sphere sampled at Braille resolution: every terminal cell holds
 * a 2x4 dot grid, the Braille character is the set of lit dots and the cell colour is
 * the mean of their shading. Palettes are sampled from the onboarding planet artwork
 * (apps/ui/sources/assets/onboarding/planet-{dark,light}.jpg).
 *
 * Choreography is part of the frame so every caller shows the same planet: it rises
 * out of an eclipse, turns while the welcome lands, comes to rest, and from then on
 * only breathes, slowly enough to signal "alive" without drawing the eye.
 */

/** Terminal cells are roughly 2.2 times taller than wide. */
const CELL_ASPECT = 2.2;
const DOT_WIDTH = 0.5;
const DOT_HEIGHT = CELL_ASPECT / 4;
const MIN_COLUMNS = 8;
const MAX_COLUMNS = 40;

/** One full, calm breath. */
export const PLANET_BREATH_SECONDS = 9.6;
/** Redraw cadence while the planet rises and turns. */
export const PLANET_FRAME_INTERVAL_MS = 66;
/** Redraw cadence once it only breathes: a slow breath needs no more. */
export const PLANET_BREATH_FRAME_INTERVAL_MS = 200;
const INTRO_SECONDS = 1.9;
const SPIN_SPEED = 0.55;
const SPIN_REST_SECONDS = 6;

/** How long an animating caller should wait before its next frame, `seconds` after the planet appeared. */
export function planetFrameIntervalMs(seconds) {
  return seconds < SPIN_REST_SECONDS ? PLANET_FRAME_INTERVAL_MS : PLANET_BREATH_FRAME_INTERVAL_MS;
}
/** A pose at rest, half-way through a breath: used for static renderings. */
const SETTLED_SECONDS = PLANET_BREATH_SECONDS * 0.75;
/** How far a dimmed planet recedes towards the terminal background. */
const DIM_OPACITY = 0.38;

const PALETTES = {
  dark: {
    background: [18, 19, 24],
    body: [
      [0, [255, 238, 150]], [0.12, [255, 204, 84]], [0.26, [254, 150, 52]], [0.38, [240, 99, 55]],
      [0.48, [204, 64, 88]], [0.57, [124, 42, 112]], [0.63, [60, 50, 150]], [0.71, [30, 86, 196]],
      [0.82, [40, 110, 214]], [0.92, [14, 60, 170]], [1, [8, 30, 110]],
    ],
    rose: [196, 58, 132],
    rim: [255, 214, 120],
    halo: [[0, [255, 190, 90]], [0.5, [214, 80, 110]], [1, [40, 70, 170]]],
  },
  light: {
    background: [251, 250, 249],
    body: [
      [0, [255, 204, 104]], [0.14, [252, 178, 84]], [0.28, [248, 150, 108]], [0.4, [242, 132, 150]],
      [0.5, [226, 124, 196]], [0.6, [180, 128, 236]], [0.7, [124, 142, 246]], [0.82, [88, 124, 240]],
      [1, [120, 152, 244]],
    ],
    rose: [230, 120, 190],
    rim: [250, 184, 90],
    halo: [[0, [250, 190, 100]], [0.5, [236, 150, 210]], [1, [130, 156, 246]]],
  },
};

const BRAILLE_BITS = [[1, 8], [2, 16], [4, 32], [64, 128]];
// 4x4 ordered-dither thresholds: sparse regions thin out without flickering.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((value) => (value + 0.5) / 16);

const clamp = (value, low = 0, high = 1) => (value < low ? low : value > high ? high : value);
const smooth = (value) => { const t = clamp(value); return t * t * t * (t * (t * 6 - 15) + 10); };
const mix = (a, b, t) => a + (b - a) * t;
const mixRgb = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

function gradient(stops, position) {
  const t = clamp(position);
  for (let index = 1; index < stops.length; index += 1) {
    const [end, to] = stops[index];
    if (t <= end) {
      const [start, from] = stops[index - 1];
      return mixRgb(from, to, (t - start) / (end - start));
    }
  }
  return stops[stops.length - 1][1];
}

function hash(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function normalize([x, y, z]) {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

const clampColumns = (columns) => Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.floor(columns ?? 28)));

export function planetRowsForColumns(columns) {
  return Math.ceil(clampColumns(columns) / CELL_ASPECT);
}

/** Calm breathing: a plain sine from fully exhaled (0) to fully inhaled (1). */
function breathAt(seconds) {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * (seconds % PLANET_BREATH_SECONDS)) / PLANET_BREATH_SECONDS);
}

/** Turns at SPIN_SPEED, decelerating evenly until it rests at SPIN_REST_SECONDS. */
function spinAt(seconds) {
  const t = Math.min(seconds, SPIN_REST_SECONDS);
  return SPIN_SPEED * (t - (t * t) / (2 * SPIN_REST_SECONDS));
}

export function createPlanetFrame(options = {}) {
  const columns = clampColumns(options.columns);
  const rows = planetRowsForColumns(columns);
  const palette = PALETTES[options.theme === 'light' ? 'light' : 'dark'];
  const seconds = Math.max(0, options.seconds ?? SETTLED_SECONDS);
  const reveal = options.intro === false ? 1 : smooth(seconds / INTRO_SECONDS);
  const breath = breathAt(seconds);
  const spin = spinAt(seconds);
  const opacity = mix(1, DIM_OPACITY, clamp(options.dim ?? 0));

  // The light swings from behind the planet (eclipse) to its resting upper-right key.
  const light = normalize([mix(0.35, 0.78, reveal), mix(-0.2, -0.42, reveal), mix(-0.95, 0.5, smooth(reveal))]);
  const width = columns;
  const height = rows * CELL_ASPECT;
  const radius = 0.74 * (0.965 + 0.035 * breath) * (Math.min(width, height) / 2);
  const glow = 1 + 0.5 * breath;
  const reach = 7 - 2 * breath;
  const tilt = 0.38;
  const [cosTilt, sinTilt] = [Math.cos(tilt), Math.sin(tilt)];

  const dotColumns = columns * 2;
  const dotRows = rows * 4;
  const lit = new Array(dotColumns * dotRows).fill(null);

  for (let dy = 0; dy < dotRows; dy += 1) {
    for (let dx = 0; dx < dotColumns; dx += 1) {
      const px = ((dx + 0.5) * DOT_WIDTH - width / 2) / radius;
      const py = ((dy + 0.5) * DOT_HEIGHT - height / 2) / radius;
      const distanceSquared = px * px + py * py;
      const threshold = BAYER[(dy & 3) * 4 + (dx & 3)];

      if (distanceSquared >= 1) {
        // Atmosphere: sparse dots hugging the lit limb, fading with altitude.
        const r = Math.sqrt(distanceSquared);
        const altitude = r - 1;
        const facing = clamp(((px * light[0] + py * light[1]) / r) * 0.8 + 0.35);
        const density = glow * facing * Math.exp(-altitude * reach) * 0.9 * clamp(reveal * 1.4);
        if (density > threshold + 0.02) {
          const colour = gradient(palette.halo, clamp((py + 1) / 2 - px * 0.2));
          lit[dy * dotColumns + dx] = mixRgb(palette.background, colour, 0.45 + 0.55 * Math.exp(-altitude * 5));
        }
        continue;
      }

      const pz = Math.sqrt(1 - distanceSquared);
      const lambert = px * light[0] + py * light[1] + pz * light[2];
      // A wide, soft terminator: the night side melts into the terminal.
      const day = smooth((lambert + 0.42) / 1.05);
      const rimFacing = clamp(((px * light[0] + py * light[1]) / Math.max(0.2, Math.sqrt(distanceSquared))) * 1.2 + 0.1);
      const rim = (1 - pz) ** 2.6 * rimFacing * (0.6 + 0.4 * reveal);

      // Planet-space coordinates on a tilted axis: surface detail turns with the spin.
      const qy = py * cosTilt - px * sinTilt;
      const qx = px * cosTilt + py * sinTilt;
      const longitude = Math.atan2(qx, pz) + spin;
      const latitude = Math.asin(clamp(qy, -1, 1));
      const bands = Math.sin(latitude * 7 + Math.sin(longitude * 2 + latitude * 3) * 0.9) * 0.5 + 0.5;
      const grain = hash(Math.floor((longitude / (Math.PI * 2)) * 180 + 1000), Math.floor(latitude * 40 + 100));
      const detail = 1 + (bands - 0.5) * 0.07 + (grain - 0.5) * 0.12;

      // Warm-to-cool diagonal of the artwork, with a rose bias towards the left limb.
      let colour = gradient(palette.body, clamp(0.44 + py * 0.6 - px * 0.12));
      colour = mixRgb(colour, palette.rose, clamp(-px * 0.35) * (1 - Math.abs(py)));
      colour = mixRgb(palette.background, colour, clamp(day * detail * (1 + 0.08 * breath)));
      colour = mixRgb(colour, palette.rim, clamp(rim * 1.1));

      // Sparse flecks travel with the spin so the rotation reads; the night side dithers away.
      const fleck = grain < 0.06 ? 0.5 : 0;
      if (clamp(day * 1.25 + rim * 2) - fleck < threshold) continue;
      lit[dy * dotColumns + dx] = colour;
    }
  }

  return Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => {
    let bits = 0;
    let count = 0;
    const sum = [0, 0, 0];
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        const colour = lit[(row * 4 + y) * dotColumns + column * 2 + x];
        if (!colour) continue;
        bits |= BRAILLE_BITS[y][x];
        count += 1;
        sum[0] += colour[0]; sum[1] += colour[1]; sum[2] += colour[2];
      }
    }
    if (bits === 0) return null;
    const rgb = mixRgb(palette.background, [sum[0] / count, sum[1] / count, sum[2] / count], opacity)
      .map((channel) => Math.round(clamp(channel, 0, 255)));
    return { ch: String.fromCharCode(0x2800 + bits), rgb };
  }));
}
