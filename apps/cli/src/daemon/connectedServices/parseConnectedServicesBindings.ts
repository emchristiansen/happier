/**
 * Connected services session bindings parser
 *
 * Spawn/session metadata includes non-secret binding decisions indicating which connected service
 * profile a session should use. This helper extracts the `(serviceId, profileId)` pairs that require
 * daemon-side credential resolution.
 */

import {
  ConnectedServiceIdSchema,
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceCodexNativeSourceV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

export type ConnectedServiceBindingSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: ConnectedServiceId;
      profileId: string;
      /** A new caller's nominated native source; its home is that source's own home of the profile. */
      nativeSource?: ConnectedServiceCodexNativeSourceV1;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: ConnectedServiceId;
      groupId: string;
      fallbackProfileId?: string;
    }>;

export type ConnectedServicesBindingsV1 = ConnectedServiceBindingsV1;

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseConnectedServiceBindingSelections(raw: unknown): ConnectedServiceBindingSelection[] {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
  if (!parsed.success) return [];
  const bindings = parsed.data.bindingsByServiceId;

  const out: ConnectedServiceBindingSelection[] = [];
  for (const [serviceIdRaw, bindingRaw] of Object.entries(bindings)) {
    const parsedId = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
    if (!parsedId.success) continue;
    const source = bindingRaw.source;
    if (source !== 'connected') continue;
    const profileId = readTrimmedString(bindingRaw.profileId);
    const selection = readTrimmedString(bindingRaw.selection);
    if (selection === 'group') {
      const groupId = readTrimmedString(bindingRaw.groupId);
      if (!groupId) continue;
      out.push({
        kind: 'group',
        serviceId: parsedId.data,
        groupId,
        ...(profileId ? { fallbackProfileId: profileId } : {}),
      });
      continue;
    }
    if (!profileId) continue;
    const nativeSource = 'nativeSource' in bindingRaw
      ? bindingRaw.nativeSource as ConnectedServiceCodexNativeSourceV1 | undefined
      : undefined;
    out.push({ kind: 'profile', serviceId: parsedId.data, profileId, ...(nativeSource ? { nativeSource } : {}) });
  }
  return out;
}

export function parseConnectedServicesBindings(raw: unknown): Array<{ serviceId: ConnectedServiceId; profileId: string }> {
  return parseConnectedServiceBindingSelections(raw).flatMap((selection) => {
    if (selection.kind === 'profile') {
      return [{ serviceId: selection.serviceId, profileId: selection.profileId }];
    }
    return selection.fallbackProfileId
      ? [{ serviceId: selection.serviceId, profileId: selection.fallbackProfileId }]
      : [];
  });
}
