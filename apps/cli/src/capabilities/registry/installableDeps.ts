import { ghDepCapability } from './depGh';
import { optionalRuntimeCapabilities } from './optionalRuntimes';

export const installableDepCapabilities = [
  ghDepCapability,
  ...optionalRuntimeCapabilities,
] as const;
