import type { SyncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

import type { NativeCryptoWorkerMode } from './nativeCryptoWorkerRouting';
import {
    NATIVE_CRYPTO_WORKER_FALLBACK_REASON,
    NATIVE_CRYPTO_WORKER_OPERATION,
    type NativeCryptoWorkerCapability,
    type NativeCryptoWorkerFallbackReason,
    type NativeCryptoWorkerOperation,
} from './types';

export type NativeCryptoWorkerBridgeSerializationFields = Readonly<{
    operation: NativeCryptoWorkerOperation;
    items: number;
    bytesIn: number;
    bytesOut: number;
    serializeMs: number;
}>;

export type NativeCryptoWorkerCapabilityTelemetryOptions = Readonly<{
    mode?: NativeCryptoWorkerMode;
}>;

export type NativeCryptoWorkerProbeFields = Readonly<{
    operation: NativeCryptoWorkerOperation;
    items: number;
    payloadBytes: number;
    available: boolean;
    failureReason: number;
    warmupMs: number;
}>;

export type NativeCryptoWorkerFallbackFields = Readonly<{
    operation: NativeCryptoWorkerOperation;
    reason: NativeCryptoWorkerFallbackReason;
    items: number;
    payloadBytes: number;
    failureReason: number;
}>;

export type NativeCryptoWorkerQueueDepthFields = Readonly<{
    operation: NativeCryptoWorkerOperation;
    queueDepth: number;
    inFlightCount: number;
}>;

export type NativeCryptoWorkerQueueWaitFields = Readonly<{
    operation: NativeCryptoWorkerOperation;
    items: number;
    queueDepth: number;
    waitMs: number;
}>;

export type NativeCryptoWorkerAppStateQuiescentFields = Readonly<{
    queueDepth: number;
    inFlightCount: number;
}>;

export type NativeCryptoWorkerAppStateActiveFields = Readonly<{
    queuedDuringQuiesceCount: number;
    capabilityRevalidatedMs: number;
    staleScopeDropsOnResume: number;
}>;

export type NativeCryptoWorkerResultDecodeFields = Readonly<{
    operation: NativeCryptoWorkerOperation;
    items: number;
    stringItems: number;
    objectItems: number;
    nullItems: number;
}>;

function encodeOperation(operation: NativeCryptoWorkerOperation): number {
    switch (operation) {
        case NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1:
            return 1;
        case NATIVE_CRYPTO_WORKER_OPERATION.decryptSecretboxJson:
            return 2;
        case NATIVE_CRYPTO_WORKER_OPERATION.decryptAesGcmJson:
            return 3;
    }
}

function encodeWorkerMode(mode: NativeCryptoWorkerMode | undefined): number {
    switch (mode) {
        case 'auto':
            return 1;
        case 'require':
            return 2;
        case 'off':
        default:
            return 0;
    }
}

export function recordNativeCryptoWorkerBridgeSerialization(
    telemetry: SyncPerformanceTelemetry,
    fields: NativeCryptoWorkerBridgeSerializationFields,
): void {
    telemetry.count('sync.crypto.worker.bridgeSerialize', {
        operation: encodeOperation(fields.operation),
        items: fields.items,
        bytesIn: fields.bytesIn,
        bytesOut: fields.bytesOut,
        serializeMs: fields.serializeMs,
    });
}

export function recordNativeCryptoWorkerCapability(
    telemetry: SyncPerformanceTelemetry,
    capability: NativeCryptoWorkerCapability,
    options: NativeCryptoWorkerCapabilityTelemetryOptions = {},
): void {
    const supportedOperations = new Set(capability.supportedOperations ?? []);
    telemetry.count('sync.crypto.worker.capability', {
        workerMode: encodeWorkerMode(options.mode),
        available: capability.available ? 1 : 0,
        failureReason: capability.failureReason,
        warmupMs: capability.warmupMs ?? 0,
        supportsDecryptDataKeyEnvelopeV1: supportedOperations.has(NATIVE_CRYPTO_WORKER_OPERATION.decryptDataKeyEnvelopeV1) ? 1 : 0,
        supportsDecryptSecretboxJson: supportedOperations.has(NATIVE_CRYPTO_WORKER_OPERATION.decryptSecretboxJson) ? 1 : 0,
        supportsDecryptAesGcmJson: supportedOperations.has(NATIVE_CRYPTO_WORKER_OPERATION.decryptAesGcmJson) ? 1 : 0,
    });
}

function encodeFallbackReason(reason: NativeCryptoWorkerFallbackReason): number {
    switch (reason) {
        case NATIVE_CRYPTO_WORKER_FALLBACK_REASON.probeFailed:
            return 1;
        case NATIVE_CRYPTO_WORKER_FALLBACK_REASON.unavailable:
            return 2;
        case NATIVE_CRYPTO_WORKER_FALLBACK_REASON.unsupportedOperation:
            return 3;
        case NATIVE_CRYPTO_WORKER_FALLBACK_REASON.nativeRunFailed:
            return 4;
    }
}

export function recordNativeCryptoWorkerFallback(
    telemetry: SyncPerformanceTelemetry,
    fields: NativeCryptoWorkerFallbackFields,
): void {
    telemetry.count('sync.crypto.worker.fallback', {
        operation: encodeOperation(fields.operation),
        reason: encodeFallbackReason(fields.reason),
        items: fields.items,
        payloadBytes: fields.payloadBytes,
        failureReason: fields.failureReason,
    });
}

export function recordNativeCryptoWorkerProbe(
    telemetry: SyncPerformanceTelemetry,
    durationMs: number,
    fields: NativeCryptoWorkerProbeFields,
): void {
    telemetry.recordDuration('sync.crypto.worker.probe', durationMs, {
        operation: encodeOperation(fields.operation),
        items: fields.items,
        payloadBytes: fields.payloadBytes,
        available: fields.available ? 1 : 0,
        failureReason: fields.failureReason,
        warmupMs: fields.warmupMs,
    });
}

export function recordNativeCryptoWorkerQueueDepth(
    telemetry: SyncPerformanceTelemetry,
    fields: NativeCryptoWorkerQueueDepthFields,
): void {
    telemetry.count('sync.crypto.worker.queueDepth', {
        operation: encodeOperation(fields.operation),
        queueDepth: fields.queueDepth,
        inFlightCount: fields.inFlightCount,
    });
}

export function recordNativeCryptoWorkerQueueWait(
    telemetry: SyncPerformanceTelemetry,
    fields: NativeCryptoWorkerQueueWaitFields,
): void {
    telemetry.recordDuration('sync.crypto.worker.queueWaitMs', fields.waitMs, {
        operation: encodeOperation(fields.operation),
        items: fields.items,
        queueDepth: fields.queueDepth,
    });
}

export function recordNativeCryptoWorkerAppStateQuiescent(
    telemetry: SyncPerformanceTelemetry,
    fields: NativeCryptoWorkerAppStateQuiescentFields,
): void {
    telemetry.count('sync.crypto.worker.appStateQuiescent', {
        queueDepth: fields.queueDepth,
        inFlightCount: fields.inFlightCount,
    });
}

export function recordNativeCryptoWorkerAppStateActive(
    telemetry: SyncPerformanceTelemetry,
    fields: NativeCryptoWorkerAppStateActiveFields,
): void {
    telemetry.count('sync.crypto.worker.appStateActive', {
        queuedDuringQuiesceCount: fields.queuedDuringQuiesceCount,
        capabilityRevalidatedMs: fields.capabilityRevalidatedMs,
        staleScopeDropsOnResume: fields.staleScopeDropsOnResume,
    });
}

export function recordNativeCryptoWorkerResultDecode(
    telemetry: SyncPerformanceTelemetry,
    durationMs: number,
    fields: NativeCryptoWorkerResultDecodeFields,
): void {
    telemetry.recordDuration('sync.crypto.worker.resultDecode', durationMs, {
        operation: encodeOperation(fields.operation),
        items: fields.items,
        stringItems: fields.stringItems,
        objectItems: fields.objectItems,
        nullItems: fields.nullItems,
    });
}
