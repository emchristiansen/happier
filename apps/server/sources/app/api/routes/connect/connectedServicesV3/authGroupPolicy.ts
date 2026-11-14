import { z } from "zod";
import {
    ConnectedServiceAuthGroupPolicyPatchV1Schema as ProtocolConnectedServiceAuthGroupPolicyPatchV1Schema,
    ConnectedServiceAuthGroupPolicyV1Schema as ProtocolConnectedServiceAuthGroupPolicyV1Schema,
} from "@happier-dev/protocol";

export const ConnectedServiceAuthGroupPolicyV1Schema = ProtocolConnectedServiceAuthGroupPolicyV1Schema;

export type ConnectedServiceAuthGroupPolicyV1 = z.infer<typeof ConnectedServiceAuthGroupPolicyV1Schema>;

export const ConnectedServiceAuthGroupPolicyPatchSchema = ProtocolConnectedServiceAuthGroupPolicyPatchV1Schema;

export type ConnectedServiceAuthGroupPolicyPatch = z.infer<typeof ConnectedServiceAuthGroupPolicyPatchSchema>;

// Older persisted policy blobs can still carry these retired no-op fields. Ignore only these
// known keys at the storage boundary; strict schema validation remains authoritative for every
// other field. This compatibility path can be removed after stored blobs are rewritten.
const RETIRED_PERSISTED_AUTH_GROUP_POLICY_KEYS = [
    "effectiveMeterStrategy",
    "memberRuntimeStatePersistence",
    "recoveryPromptMode",
] as const;

function omitRetiredPersistedAuthGroupPolicyKeys(value: unknown): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return value;
    }

    const policy = { ...value } as Record<string, unknown>;
    for (const key of RETIRED_PERSISTED_AUTH_GROUP_POLICY_KEYS) {
        delete policy[key];
    }
    return policy;
}

export const DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1: ConnectedServiceAuthGroupPolicyV1 = Object.freeze({
    ...ConnectedServiceAuthGroupPolicyV1Schema.parse({}),
});

export function mergeConnectedServiceAuthGroupPolicyPatch(
    base: ConnectedServiceAuthGroupPolicyV1,
    patch: ConnectedServiceAuthGroupPolicyPatch | undefined,
): ConnectedServiceAuthGroupPolicyV1 {
    if (!patch) return base;
    const merged = ConnectedServiceAuthGroupPolicyV1Schema.parse({
        ...base,
        ...patch,
        switchOn: {
            ...base.switchOn,
            ...patch.switchOn,
        },
    });
    if (merged.strategy === "per_session_softmax") return merged;
    // Softmax parameters belong to that strategy only; leaving it drops them so a stored policy
    // never carries parameters its strategy ignores.
    const { softmaxTemperature: _temperature, softmaxOffsetPercent: _offset, ...withoutSoftmax } = merged;
    return withoutSoftmax;
}

export function parseConnectedServiceAuthGroupPolicyJson(policyJson: string): ConnectedServiceAuthGroupPolicyV1 {
    try {
        const storedPolicy: unknown = JSON.parse(policyJson);
        return ConnectedServiceAuthGroupPolicyV1Schema.parse(
            omitRetiredPersistedAuthGroupPolicyKeys(storedPolicy),
        );
    } catch {
        return DEFAULT_CONNECTED_SERVICE_AUTH_GROUP_POLICY_V1;
    }
}

export function stringifyConnectedServiceAuthGroupPolicy(policy: ConnectedServiceAuthGroupPolicyV1): string {
    return JSON.stringify(ConnectedServiceAuthGroupPolicyV1Schema.parse(policy));
}
