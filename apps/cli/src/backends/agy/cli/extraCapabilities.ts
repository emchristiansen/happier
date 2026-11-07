import { agyAcpDepCapability } from '@/capabilities/registry/depAgyAcp';
import type { Capability } from '@/capabilities/service';

export const capabilities: ReadonlyArray<Capability> = [
  agyAcpDepCapability,
];
