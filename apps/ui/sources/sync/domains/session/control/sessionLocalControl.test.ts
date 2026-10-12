import { describe, expect, it } from 'vitest';

import {
    getSessionLocalControlState,
    isSessionRemoteWritableWhileLocallyAttached,
} from './sessionLocalControl';
import { createSessionFixture } from '@/dev/testkit';

describe('session local control state', () => {
    it('does not infer remote writeability from shared topology when the field is omitted', () => {
        const session = createSessionFixture({
            active: true,
            agentState: {
                localControl: {
                    attached: true,
                    topology: 'shared',
                },
            },
        });

        expect(getSessionLocalControlState(session)).toMatchObject({
            attached: true,
            topology: 'shared',
            remoteWritable: false,
            canDetach: false,
        });
        expect(isSessionRemoteWritableWhileLocallyAttached(session)).toBe(false);
    });

    it('preserves explicit provider-server writeability for shared attachment', () => {
        const session = createSessionFixture({
            active: true,
            agentState: {
                localControl: {
                    attached: true,
                    topology: 'shared',
                    remoteWritable: true,
                },
            },
        });

        expect(getSessionLocalControlState(session)?.remoteWritable).toBe(true);
        expect(isSessionRemoteWritableWhileLocallyAttached(session)).toBe(true);
    });

    it.each(['shared', 'exclusive'] as const)('does not project historical %s control after the runner stops', (topology) => {
        const session = createSessionFixture({
            active: false,
            agentState: { controlledByUser: true, localControl: {
                attached: true, topology, remoteWritable: true, canAttach: true, canDetach: true,
            } },
        });
        expect(getSessionLocalControlState(session)).toBeNull();
        expect(isSessionRemoteWritableWhileLocallyAttached(session)).toBe(false);
    });

    it('does not revive stopped legacy control when metadata is unavailable', () => {
        const session = createSessionFixture({ active: false, metadata: null, agentState: { controlledByUser: true } });
        expect(getSessionLocalControlState(session)).toBeNull();
    });

    it.each([
        { state: 'unknown', retired: true },
        { state: 'recoverable_unservable' },
    ] as const)('does not advertise live control when attachment evidence is unavailable (%j)', (evidence) => {
        const session = createSessionFixture({
            active: true,
            metadata: { path: '/workspace', host: 'machine', terminal: {
                mode: 'herdr', controlServiceabilityV1: {
                    v: 1, attachmentId: 'attachment-1', observedAt: 10, ...evidence,
                },
            } },
            agentState: { controlledByUser: true, localControl: {
                attached: true, topology: 'shared', remoteWritable: true, canAttach: true, canDetach: true,
            } },
        });
        expect(getSessionLocalControlState(session)).toBeNull();
    });

    it('projects legacy live control without terminal serviceability metadata', () => {
        expect(getSessionLocalControlState(createSessionFixture({
            active: true, agentState: { controlledByUser: true },
        }))).toMatchObject({ attached: true, topology: 'exclusive', canDetach: true });
    });
});
