export type PlanetTheme = 'dark' | 'light';

export type PlanetCell = Readonly<{
  /** One Braille character (U+2801–U+28FF): the lit dots of this cell. */
  ch: string;
  rgb: readonly [number, number, number];
}>;

export type PlanetFrame = readonly (readonly (PlanetCell | null)[])[];

/** One full, calm breath, in seconds. */
export const PLANET_BREATH_SECONDS: number;
/** Redraw cadence while the planet rises and turns. */
export const PLANET_FRAME_INTERVAL_MS: number;
/** Redraw cadence once it only breathes. */
export const PLANET_BREATH_FRAME_INTERVAL_MS: number;

/** How long an animating caller should wait before its next frame, `seconds` after the planet appeared. */
export function planetFrameIntervalMs(seconds: number): number;

export function planetRowsForColumns(columns?: number): number;

export function createPlanetFrame(options?: Readonly<{
  columns?: number;
  /** Seconds since the planet appeared. Omit for the settled, fully lit pose. */
  seconds?: number;
  /** false starts fully lit instead of rising out of an eclipse. */
  intro?: boolean;
  /** 0 = present, 1 = receded towards the terminal background. */
  dim?: number;
  theme?: PlanetTheme;
}>): PlanetFrame;
